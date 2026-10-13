import { describe, expect, it } from "vitest";
import { commandFailureDetail, prepareWorkspaceRoot } from "../src/sandbox/e2b-provider.js";

type Call = { command: string; options?: { user?: string; timeoutMs?: number } | undefined };

function fakeSandbox(whoami: string, failRoot = false) {
  const calls: Call[] = [];
  const sandbox = {
    sandboxId: "sbx",
    commands: {
      run: async (command: string, options?: { user?: string; timeoutMs?: number }) => {
        calls.push({ command, options });
        if (command === "id -un") return { exitCode: 0, stdout: `${whoami}\n`, stderr: "" };
        if (failRoot) throw { exitCode: 1, stdout: "", stderr: "install: permission denied", error: "exit status 1" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    files: { write: async () => undefined, read: async () => "" },
    updateNetwork: async () => undefined,
    createSnapshot: async () => ({ snapshotId: "s" }),
    kill: async () => undefined,
  };
  return { sandbox, calls };
}

// Live run 2026-10-13: E2B's default user could not create /workspace
// ("mkdir: cannot create directory '/workspace': Permission denied").
describe("prepareWorkspaceRoot", () => {
  it("creates only /workspace as root and gives it to the default sandbox user", async () => {
    const { sandbox, calls } = fakeSandbox("user");
    await prepareWorkspaceRoot(sandbox);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: "id -un" });
    expect(calls[0]!.options?.user).toBeUndefined();
    expect(calls[1]!.options?.user).toBe("root");
    expect(calls[1]!.command).toBe('install -d -m 0755 -o user -g "$(id -gn user)" /workspace');
  });

  it("refuses an unexpected username instead of interpolating it into a root command", async () => {
    const { sandbox, calls } = fakeSandbox("user; rm -rf /");
    await expect(prepareWorkspaceRoot(sandbox)).rejects.toThrow("could not determine sandbox user");
    expect(calls.filter((call) => call.options?.user === "root")).toHaveLength(0);
  });

  it("reports stderr when the root step fails", async () => {
    const { sandbox } = fakeSandbox("user", true);
    await expect(prepareWorkspaceRoot(sandbox)).rejects.toThrow("stderr: install: permission denied");
  });
});

describe("commandFailureDetail", () => {
  it("includes stderr alongside E2B's generic exit status", () => {
    expect(commandFailureDetail({ exitCode: 1, error: "exit status 1", stderr: "mkdir: cannot create directory '/workspace': Permission denied\n" }))
      .toBe("exit status 1; stderr: mkdir: cannot create directory '/workspace': Permission denied");
  });

  it("keeps only the stderr tail", () => {
    const detail = commandFailureDetail({ exitCode: 2, stderr: `${"x".repeat(3_000)}END` });
    expect(detail.startsWith("exit status 2; stderr: …")).toBe(true);
    expect(detail.endsWith("END")).toBe(true);
    expect(detail.length).toBeLessThan(1_600);
  });
});
