import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { networkPolicyForPhase } from "../../../evals/src/sandbox/network-policy.js";
import { verificationGatewayPlaceholder } from "../src/verification.js";

// Live run 2026-10-13: coding succeeded, then verification failed with
// "gatewayUrl must use https" because it passed http://127.0.0.1:1.
describe("verification gateway placeholder", () => {
  it("passes network policy validation for every phase verification uses", () => {
    for (const phase of ["locked", "dependency-setup", "offline"] as const) {
      expect(() => networkPolicyForPhase(phase, verificationGatewayPlaceholder)).not.toThrow();
      expect(networkPolicyForPhase(phase, verificationGatewayPlaceholder).allowHosts).not.toContain("verification.invalid");
    }
  });

  it("is used for both verification sandboxes instead of an http address", async () => {
    const source = await readFile("apps/worker/src/verification.ts", "utf8");
    expect(source.match(/gatewayUrl: verificationGatewayPlaceholder/g)).toHaveLength(2);
    expect(source).not.toContain("http://127.0.0.1:1");
  });
});
