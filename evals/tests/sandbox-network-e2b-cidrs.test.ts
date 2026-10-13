import { describe, expect, it } from "vitest";
import { networkPolicyForPhase, toE2BCreateNetwork, toE2BEgressUpdate } from "../src/sandbox/network-policy.js";

// Live run 2026-10-13: E2B rejected sandbox creation with
// "400: invalid denied CIDR ::/0". Only E2B's ALL_TRAFFIC CIDR may be sent.
describe("E2B deny-all CIDRs", () => {
  const phases = ["coding", "testing", "offline"] as const;

  it.each(phases)("never sends ::/0 and always denies all IPv4 in the %s phase", (phase) => {
    const policy = networkPolicyForPhase(phase, "https://gateway.example.com/v1");
    for (const network of [toE2BCreateNetwork(policy), toE2BEgressUpdate(policy)]) {
      expect(network.denyOut).toEqual(["0.0.0.0/0"]);
      expect(network.denyOut).not.toContain("::/0");
    }
  });
});
