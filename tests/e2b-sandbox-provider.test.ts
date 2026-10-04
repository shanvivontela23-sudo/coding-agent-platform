import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2BSandboxProvider } from "../src/sandbox/e2b-provider.js";
import {
  sandboxArchivePath,
  sandboxWorkspacePath,
} from "../src/sandbox/repository-bootstrap.js";

type Network = {
  allowOut?: string[];
  denyOut?: string[];
  allowPublicTraffic?: boolean;
};

class FakeSandbox {
  sandboxId = "sandbox-123";
  readonly commandsRun: Array<{ command: string; options?: unknown }> = [];
  readonly writes: Array<{ path: string; data: string | ArrayBuffer }> = [];
  readonly reads = new Map<string, string>();
  readonly networkUpdates: Network[] = [];
  readonly snapshots: Array<{ name?: string }> = [];
  killed = 0;
  failWhenCommandIncludes?: string;

  commands = {
    run: async (
      command: string,
      options?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    ) => {
      this.commandsRun.push({ command, options });
      if (
        this.failWhenCommandIncludes &&
        command.includes(this.failWhenCommandIncludes)
      ) {
        throw {
          exitCode: 23,
          stdout: "",
          stderr: "simulated command failure",
          error: "command failed",
        };
      }

      if (command.includes("git diff --binary")) {
        return {
          exitCode: 0,
          stdout: "diff --git a/file.ts b/file.ts\n",
          stderr: "",
        };
      }

      if (command.includes("git status --porcelain")) {
        return {
          exitCode: 0,
          stdout: " M file.ts\n",
          stderr: "",
        };
      }

      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  files = {
    write: async (path: string, data: string | ArrayBuffer) => {
      this.writes.push({ path, data });
    },
    read: async (path: string) => this.reads.get(path) ?? "",
  };

  async updateNetwork(network: Network) {
    this.networkUpdates.push(network);
  }

  async createSnapshot(options?: { name?: string }) {
    this.snapshots.push(options ?? {});
    return { snapshotId: "snapshot-1" };
  }

  async kill() {
    this.killed += 1;
  }
}

function archiveFixture() {
  const archive = new TextEncoder().encode("fake tar.gz bytes for unit tests");
  return {
    pinnedCommit: "a".repeat(40),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archive,
  };
}

function fakeClient(sandbox: FakeSandbox) {
  const createCalls: unknown[] = [];

  return {
    createCalls,
    client: {
      Sandbox: {
        create: async (options: unknown) => {
          createCalls.push(options);
          return sandbox;
        },
      },
    },
  };
}

describe("E2BSandboxProvider", () => {
  it("creates locked, uploads only the pinned archive, and bootstraps without source history", async () => {
    const sandbox = new FakeSandbox();
    const { client, createCalls } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });

    const session = await provider.create({
      taskId: "task-001",
      repository: archiveFixture(),
      gatewayUrl: "https://gateway.example.com/v1",
    });

    expect(session.id).toBe("sandbox-123");
    expect(session.workspacePath).toBe(sandboxWorkspacePath);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      template: "base",
      metadata: { taskId: "task-001" },
      network: {
        allowOut: [],
        denyOut: ["0.0.0.0/0"],
        allowPublicTraffic: false,
      },
      lifecycle: {
        onTimeout: "kill",
        autoResume: false,
      },
    });
    expect(createCalls[0]).not.toHaveProperty("envs");

    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.writes[0]!.path).toBe(sandboxArchivePath);
    expect(sandbox.commandsRun.some(({ command }) => command.includes("sha256sum -c -"))).toBe(true);

    const bootstrap = sandbox.commandsRun.find(({ command }) =>
      command.includes("git init -q"),
    );
    expect(bootstrap?.command).toContain('git rev-list --count HEAD');
    expect(bootstrap?.command).not.toContain("git clone");
    expect(bootstrap?.command).not.toContain("git fetch");
  });

  it("switches from registry-only setup to gateway-only coding/testing", async () => {
    const sandbox = new FakeSandbox();
    const { client } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });

    const session = await provider.create({
      taskId: "task-002",
      repository: archiveFixture(),
      gatewayUrl: "https://gateway.example.com/v1",
      extraDependencyHosts: ["packages.example.internal"],
    });

    await session.setNetworkPhase("dependency-setup");
    await session.setNetworkPhase("coding");
    await session.setNetworkPhase("testing");

    expect(sandbox.networkUpdates[0]!.allowOut).toContain("registry.npmjs.org");
    expect(sandbox.networkUpdates[0]!.allowOut).toContain(
      "packages.example.internal",
    );
    expect(sandbox.networkUpdates[0]!.allowOut).not.toContain(
      "gateway.example.com",
    );

    expect(sandbox.networkUpdates[1]).toEqual({
      allowOut: ["gateway.example.com"],
      denyOut: ["0.0.0.0/0"],
    });
    expect(sandbox.networkUpdates[2]).toEqual(sandbox.networkUpdates[1]);
  });

  it("limits control-plane file APIs to the task workspace", async () => {
    const sandbox = new FakeSandbox();
    const { client } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });

    const session = await provider.create({
      taskId: "task-003",
      repository: archiveFixture(),
      gatewayUrl: "https://gateway.example.com/v1",
    });

    await expect(session.readFile("/etc/passwd")).rejects.toThrow(
      "external sandbox file access is limited",
    );
    await expect(
      session.writeFile("/tmp/not-allowed", "no"),
    ).rejects.toThrow("external sandbox file access is limited");

    await session.writeFile(`${sandboxWorkspacePath}/allowed.txt`, "yes");
    expect(sandbox.writes.at(-1)?.path).toBe(
      `${sandboxWorkspacePath}/allowed.txt`,
    );
  });

  it("exports an unstaged binary-capable patch and status", async () => {
    const sandbox = new FakeSandbox();
    const { client } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });

    const session = await provider.create({
      taskId: "task-004",
      repository: archiveFixture(),
      gatewayUrl: "https://gateway.example.com/v1",
    });

    const exported = await session.exportPatch();

    expect(exported.patch).toContain("diff --git");
    expect(exported.status).toContain("M file.ts");
    expect(
      sandbox.commandsRun.some(({ command }) =>
        command.includes("git add --intent-to-add -A"),
      ),
    ).toBe(true);
  });

  it("kills the sandbox when repository bootstrap fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.failWhenCommandIncludes = "git init -q";
    const { client } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });

    await expect(
      provider.create({
        taskId: "task-005",
        repository: archiveFixture(),
        gatewayUrl: "https://gateway.example.com/v1",
      }),
    ).rejects.toThrow("repository bootstrap failed");

    expect(sandbox.killed).toBe(1);
  });

  it("destroys idempotently and exposes snapshot IDs", async () => {
    const sandbox = new FakeSandbox();
    const { client } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });

    const session = await provider.create({
      taskId: "task-006",
      repository: archiveFixture(),
      gatewayUrl: "https://gateway.example.com/v1",
    });

    await expect(session.snapshot("checkpoint")).resolves.toEqual({
      id: "snapshot-1",
    });

    await session.destroy();
    await session.destroy();

    expect(sandbox.killed).toBe(1);
    expect(sandbox.snapshots).toEqual([{ name: "checkpoint" }]);
    await expect(
      session.exec({ command: "echo should-not-run" }),
    ).rejects.toThrow("already been destroyed");
  });

  it("does not create a sandbox when the control-plane archive digest is wrong", async () => {
    const sandbox = new FakeSandbox();
    const { client, createCalls } = fakeClient(sandbox);
    const provider = new E2BSandboxProvider({ client });
    const repository = archiveFixture();

    await expect(
      provider.create({
        taskId: "task-007",
        repository: {
          ...repository,
          archiveSha256: "f".repeat(64),
        },
        gatewayUrl: "https://gateway.example.com/v1",
      }),
    ).rejects.toThrow("archive SHA-256 does not match");

    expect(createCalls).toHaveLength(0);
  });
});
