import type { SandboxCommandResult, SandboxProvider, SandboxSession } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "./execution-source.js";

export type VerificationCheck = {
  readonly name: "test" | "build";
  readonly command: string;
  readonly baselineExitCode: number;
  readonly patchedExitCode: number;
  readonly status: "passed" | "failed" | "pre_existing" | "skipped";
};

export type ReproduceProof = {
  readonly command: string | null;
  readonly baselineExitCode: number | null;
  readonly patchedExitCode: number | null;
  readonly reproduced: boolean;
};

export type VerificationResult = {
  readonly checks: readonly VerificationCheck[];
  readonly hasNewFailures: boolean;
  readonly reproduce: ReproduceProof;
};

type SessionRun = {
  readonly checks: ReadonlyMap<string, SandboxCommandResult>;
  readonly reproduction: SandboxCommandResult | null;
};

async function executeChecks(options: {
  readonly session: SandboxSession;
  readonly source: PreparedExecutionSource;
  readonly patch: string | null;
  readonly reproductionCommand: string | null;
  readonly timeoutMs: number;
}): Promise<SessionRun> {
  const { session, source, patch, reproductionCommand, timeoutMs } = options;
  await session.setNetworkPhase("dependency-setup");
  if (source.commands.install) {
    const install = await session.exec({ command: source.commands.install, cwd: session.workspacePath, timeoutMs });
    if (install.exitCode !== 0) throw new Error("Verification dependency setup failed");
  }
  await session.setNetworkPhase("offline");

  if (patch !== null) {
    const patchPath = `${session.workspacePath}/.dhara.patch`;
    await session.writeFile(patchPath, patch);
    const applied = await session.exec({ command: "git apply --binary --whitespace=nowarn .dhara.patch", cwd: session.workspacePath, timeoutMs });
    if (applied.exitCode !== 0) throw new Error("Exported patch does not apply cleanly to approved source");
  }

  const checks = new Map<string, SandboxCommandResult>();
  if (source.commands.test) checks.set("test", await session.exec({ command: source.commands.test, cwd: session.workspacePath, timeoutMs }));
  if (source.commands.build) checks.set("build", await session.exec({ command: source.commands.build, cwd: session.workspacePath, timeoutMs }));
  const reproduction = reproductionCommand
    ? await session.exec({ command: reproductionCommand, cwd: session.workspacePath, timeoutMs })
    : null;
  return { checks, reproduction };
}

export async function verifyExecution(options: {
  readonly sandboxProvider: SandboxProvider;
  readonly taskId: string;
  readonly source: PreparedExecutionSource;
  readonly patch: string;
  readonly reproductionCommand: string | null;
  readonly timeoutMs?: number;
}): Promise<VerificationResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const baseline = await options.sandboxProvider.create({
    taskId: `${options.taskId}-baseline`,
    repository: options.source.repository,
    gatewayUrl: "http://127.0.0.1:1",
    timeoutMs,
  });
  let baselineRun: SessionRun;
  try {
    baselineRun = await executeChecks({
      session: baseline,
      source: options.source,
      patch: null,
      reproductionCommand: options.reproductionCommand,
      timeoutMs,
    });
  } finally {
    await baseline.destroy();
  }

  const patched = await options.sandboxProvider.create({
    taskId: `${options.taskId}-patched`,
    repository: options.source.repository,
    gatewayUrl: "http://127.0.0.1:1",
    timeoutMs,
  });
  let patchedRun: SessionRun;
  try {
    patchedRun = await executeChecks({
      session: patched,
      source: options.source,
      patch: options.patch,
      reproductionCommand: options.reproductionCommand,
      timeoutMs,
    });
  } finally {
    await patched.destroy();
  }

  const checks: VerificationCheck[] = [];
  for (const [name, command] of [["test", options.source.commands.test], ["build", options.source.commands.build]] as const) {
    if (!command) continue;
    const before = baselineRun.checks.get(name);
    const after = patchedRun.checks.get(name);
    if (!before || !after) throw new Error(`Missing ${name} verification result`);
    const status: VerificationCheck["status"] = after.exitCode === 0
      ? "passed"
      : before.exitCode !== 0
        ? "pre_existing"
        : "failed";
    checks.push({ name, command, baselineExitCode: before.exitCode, patchedExitCode: after.exitCode, status });
  }

  const baselineReproduction = baselineRun.reproduction;
  const patchedReproduction = patchedRun.reproduction;
  const reproduce: ReproduceProof = options.reproductionCommand
    ? {
        command: options.reproductionCommand,
        baselineExitCode: baselineReproduction?.exitCode ?? null,
        patchedExitCode: patchedReproduction?.exitCode ?? null,
        reproduced: baselineReproduction?.exitCode !== 0 && patchedReproduction?.exitCode === 0,
      }
    : { command: null, baselineExitCode: null, patchedExitCode: null, reproduced: false };

  return {
    checks,
    hasNewFailures: checks.some((check) => check.status === "failed"),
    reproduce,
  };
}
