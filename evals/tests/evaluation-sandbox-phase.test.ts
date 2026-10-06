import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2BSandboxProvider } from "../src/sandbox/e2b-provider.js";
import { networkPolicyForPhase, toE2BEgressUpdate } from "../src/sandbox/network-policy.js";

const baselineSha = "b".repeat(40);

class FakeSandbox {
  sandboxId = "evaluation-sandbox";
  readonly networkUpdates: Array<{ allowOut?: string[]; denyOut?: string[] }> = [];
  commands = {
    run: async (command: string) => {
      if (command.includes("git rev-parse HEAD")) {
        return { exitCode: 0, stdout: `${baselineSha}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  files = {
    write: async () => undefined,
    read: async () => "",
  };
  async updateNetwork(network: { allowOut?: string[]; denyOut?: string[] }) {
    this.networkUpdates.push(network);
  }
  async createSnapshot() {
    return { snapshotId: "snapshot" };
  }
  async kill() {}
}

function repositoryFixture() {
  const archive = new TextEncoder().encode("synthetic archive");
  return {
    pinnedCommit: "a".repeat(40),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archive,
  };
}

describe("offline evaluation sandbox phase", () => {
  it("has explicit IPv4/IPv6 deny-all policy with no allowlisted hosts", () => {
    const policy = networkPolicyForPhase(
      "evaluation" as never,
      "https://gateway.example.com/v1",
    );

    expect(policy).toEqual({ allowHosts: [], denyAllOtherEgress: true });
    expect(toE2BEgressUpdate(policy)).toEqual({
      allowOut: [],
      denyOut: ["0.0.0.0/0", "::/0"],
    });
  });

  it("permits dependency-setup -> evaluation as a terminal transition", async () => {
    const sandbox = new FakeSandbox();
    const provider = new E2BSandboxProvider({
      client: {
        Sandbox: {
          create: async () => sandbox,
        },
      },
    });
    const session = await provider.create({
      taskId: "task-eval",
      repository: repositoryFixture(),
      gatewayUrl: "https://gateway.example.com/v1",
    });

    await session.setNetworkPhase("dependency-setup");
    await (session.setNetworkPhase as (phase: string) => Promise<void>)("evaluation");

    expect(sandbox.networkUpdates).toHaveLength(2);
    expect(sandbox.networkUpdates[1]).toEqual({
      allowOut: [],
      denyOut: ["0.0.0.0/0", "::/0"],
    });
    await expect(session.setNetworkPhase("coding")).rejects.toThrow(
      "evaluation -> coding",
    );
  });
});
