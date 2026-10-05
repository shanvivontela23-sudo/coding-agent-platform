import { posix } from "node:path";
import { E2B } from "e2b";
import {
  buildArchiveVerificationCommand,
  buildBaselineCommitCommand,
  buildPatchExportCommand,
  buildRepositoryBootstrapCommand,
  buildStatusCommand,
  sandboxArchivePath,
  sandboxWorkspacePath,
  validateBaselineCommitSha,
  validatePinnedRepositoryArchive,
} from "./repository-bootstrap.js";
import {
  networkPolicyForPhase,
  toE2BCreateNetwork,
  toE2BEgressUpdate,
} from "./network-policy.js";
import type {
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateRequest,
  SandboxNetworkPhase,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
} from "./types.js";

type E2BCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type E2BSandboxLike = {
  sandboxId: string;
  commands: {
    run(
      command: string,
      options?: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
      },
    ): Promise<E2BCommandResult>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string): Promise<string>;
  };
  updateNetwork(network: {
    allowOut?: string[];
    denyOut?: string[];
  }): Promise<unknown>;
  createSnapshot(options?: { name?: string }): Promise<{ snapshotId: string }>;
  kill(): Promise<unknown>;
};

type E2BClientLike = {
  Sandbox: {
    create(options: {
      template?: string;
      timeoutMs?: number;
      metadata?: Record<string, string>;
      network?: {
        allowOut?: string[];
        denyOut?: string[];
        allowPublicTraffic?: boolean;
      };
      lifecycle?: {
        onTimeout: "kill";
        autoResume: false;
      };
    }): Promise<E2BSandboxLike>;
  };
};

export type E2BSandboxProviderOptions = {
  readonly apiKey?: string;
  readonly domain?: string;
  readonly requestTimeoutMs?: number;
  readonly defaultTemplate?: string;
  readonly defaultTimeoutMs?: number;
  readonly client?: E2BClientLike;
};

const networkPhaseOrder: readonly SandboxNetworkPhase[] = [
  "locked",
  "dependency-setup",
  "coding",
  "testing",
];

function isCommandExitLike(error: unknown): error is E2BCommandResult {
  return (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number" &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string" &&
    "stderr" in error &&
    typeof (error as { stderr?: unknown }).stderr === "string"
  );
}

function normalizeWorkspacePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error("sandbox file path must not contain NUL bytes");
  }

  const normalized = path.startsWith("/")
    ? posix.normalize(path)
    : posix.resolve(sandboxWorkspacePath, path);

  if (
    normalized !== sandboxWorkspacePath &&
    !normalized.startsWith(`${sandboxWorkspacePath}/`)
  ) {
    throw new Error(
      `external sandbox file access is limited to ${sandboxWorkspacePath}`,
    );
  }

  return normalized;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer;
}

class E2BSandboxSession implements SandboxSession {
  readonly workspacePath = sandboxWorkspacePath;
  private destroyed = false;
  private networkPhase: SandboxNetworkPhase = "locked";

  constructor(
    readonly id: string,
    readonly baselineCommitSha: string,
    private readonly sandbox: E2BSandboxLike,
    private readonly gatewayUrl: string,
    private readonly extraDependencyHosts: readonly string[],
  ) {}

  async exec(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.assertAlive();

    try {
      return await this.sandbox.commands.run(command.command, {
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.env ? { envs: { ...command.env } } : {}),
        ...(command.timeoutMs !== undefined
          ? { timeoutMs: command.timeoutMs }
          : {}),
      });
    } catch (error) {
      if (isCommandExitLike(error)) {
        return {
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
          ...(error.error ? { error: error.error } : {}),
        };
      }
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    return await this.sandbox.files.read(normalizeWorkspacePath(path));
  }

  async writeFile(path: string, data: string | ArrayBuffer): Promise<void> {
    this.assertAlive();
    await this.sandbox.files.write(normalizeWorkspacePath(path), data);
  }

  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> {
    this.assertAlive();

    if (phase === this.networkPhase) return;

    const currentIndex = networkPhaseOrder.indexOf(this.networkPhase);
    const requestedIndex = networkPhaseOrder.indexOf(phase);
    const expectedPhase = networkPhaseOrder[currentIndex + 1];

    if (requestedIndex !== currentIndex + 1 || expectedPhase !== phase) {
      throw new Error(
        `invalid sandbox network phase transition: ${this.networkPhase} -> ${phase}`,
      );
    }

    const policy = networkPolicyForPhase(
      phase,
      this.gatewayUrl,
      this.extraDependencyHosts,
    );
    await this.sandbox.updateNetwork(toE2BEgressUpdate(policy));
    this.networkPhase = phase;
  }

  async exportPatch(): Promise<SandboxPatch> {
    this.assertAlive();

    const patch = await this.exec({
      command: buildPatchExportCommand(this.baselineCommitSha),
      cwd: sandboxWorkspacePath,
      timeoutMs: 60_000,
    });
    if (patch.exitCode !== 0) {
      throw new Error(
        `failed to export patch: ${patch.error ?? patch.stderr ?? "unknown error"}`,
      );
    }

    const status = await this.exec({
      command: buildStatusCommand(),
      cwd: sandboxWorkspacePath,
      timeoutMs: 30_000,
    });
    if (status.exitCode !== 0) {
      throw new Error(
        `failed to read workspace status: ${status.error ?? status.stderr ?? "unknown error"}`,
      );
    }

    return {
      patch: patch.stdout,
      status: status.stdout,
    };
  }

  async snapshot(name?: string): Promise<SandboxSnapshot> {
    this.assertAlive();
    const snapshot = await this.sandbox.createSnapshot(
      name ? { name } : undefined,
    );
    return { id: snapshot.snapshotId };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.sandbox.kill();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error("sandbox session has already been destroyed");
    }
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly client: E2BClientLike;
  private readonly defaultTemplate: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: E2BSandboxProviderOptions) {
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.apiKey) {
        throw new Error("E2B apiKey is required when no client is injected");
      }

      this.client = new E2B({
        apiKey: options.apiKey,
        ...(options.domain ? { domain: options.domain } : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
      });
    }

    this.defaultTemplate = options.defaultTemplate ?? "base";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30 * 60 * 1_000;
  }

  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    validatePinnedRepositoryArchive(request.repository);

    const lockedPolicy = networkPolicyForPhase("locked", request.gatewayUrl);
    const sandbox = await this.client.Sandbox.create({
      template: request.template ?? this.defaultTemplate,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
      metadata: {
        taskId: request.taskId,
      },
      network: toE2BCreateNetwork(lockedPolicy),
      lifecycle: {
        onTimeout: "kill",
        autoResume: false,
      },
    });

    try {
      await sandbox.files.write(
        sandboxArchivePath,
        asArrayBuffer(request.repository.archive),
      );

      const verify = await runRaw(
        sandbox,
        buildArchiveVerificationCommand(request.repository.archiveSha256),
        30_000,
      );
      if (verify.exitCode !== 0) {
        throw new Error(
          `uploaded repository archive failed verification: ${verify.error ?? verify.stderr}`,
        );
      }

      const bootstrap = await runRaw(
        sandbox,
        buildRepositoryBootstrapCommand(request.repository.pinnedCommit),
        120_000,
      );
      if (bootstrap.exitCode !== 0) {
        throw new Error(
          `repository bootstrap failed: ${bootstrap.error ?? bootstrap.stderr}`,
        );
      }

      const baseline = await runRaw(
        sandbox,
        buildBaselineCommitCommand(),
        30_000,
      );
      if (baseline.exitCode !== 0) {
        throw new Error(
          `failed to record repository baseline commit: ${baseline.error ?? baseline.stderr}`,
        );
      }
      const baselineCommitSha = validateBaselineCommitSha(baseline.stdout);

      return new E2BSandboxSession(
        sandbox.sandboxId,
        baselineCommitSha,
        sandbox,
        request.gatewayUrl,
        request.extraDependencyHosts ?? [],
      );
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }
}

async function runRaw(
  sandbox: E2BSandboxLike,
  command: string,
  timeoutMs: number,
): Promise<SandboxCommandResult> {
  try {
    return await sandbox.commands.run(command, { timeoutMs });
  } catch (error) {
    if (isCommandExitLike(error)) {
      return {
        exitCode: error.exitCode,
        stdout: error.stdout,
        stderr: error.stderr,
        ...(error.error ? { error: error.error } : {}),
      };
    }
    throw error;
  }
}
