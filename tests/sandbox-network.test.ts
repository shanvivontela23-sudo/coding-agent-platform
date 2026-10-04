import { describe, expect, it } from "vitest";
import {
  defaultDependencyHosts,
  networkPolicyForPhase,
  toE2BCreateNetwork,
} from "../src/sandbox/network-policy.js";

describe("networkPolicyForPhase", () => {
  it("denies all egress while locked", () => {
    const policy = networkPolicyForPhase(
      "locked",
      "https://gateway.example.com/v1",
    );

    expect(policy.allowHosts).toEqual([]);
    expect(toE2BCreateNetwork(policy)).toEqual({
      allowOut: [],
      denyOut: ["0.0.0.0/0"],
      allowPublicTraffic: false,
    });
  });

  it("allows package and git hosts only during dependency setup", () => {
    const policy = networkPolicyForPhase(
      "dependency-setup",
      "https://gateway.example.com/v1",
      ["packages.example.internal"],
    );

    expect(policy.allowHosts).toContain("registry.npmjs.org");
    expect(policy.allowHosts).toContain("pypi.org");
    expect(policy.allowHosts).toContain("repo.maven.apache.org");
    expect(policy.allowHosts).toContain("api.nuget.org");
    expect(policy.allowHosts).toContain("github.com");
    expect(policy.allowHosts).toContain("packages.example.internal");
    expect(policy.allowHosts).not.toContain("gateway.example.com");
    expect(policy.allowHosts.length).toBe(
      new Set([...defaultDependencyHosts, "packages.example.internal"]).size,
    );
  });

  it.each(["coding", "testing"] as const)(
    "allows only the gateway while in %s",
    (phase) => {
      const policy = networkPolicyForPhase(
        phase,
        "https://Gateway.Example.com/v1/chat",
      );

      expect(policy.allowHosts).toEqual(["gateway.example.com"]);
      expect(policy.denyAllOtherEgress).toBe(true);
    },
  );

  it("rejects a non-HTTPS gateway", () => {
    expect(() =>
      networkPolicyForPhase("coding", "http://gateway.example.com"),
    ).toThrow("gatewayUrl must use https");
  });

  it("rejects wildcard, CIDR, and URL-shaped dependency egress entries", () => {
    for (const host of [
      "*.example.com",
      "0.0.0.0/0",
      "https://packages.example.com",
      "packages.example.com:443",
    ]) {
      expect(() =>
        networkPolicyForPhase(
          "dependency-setup",
          "https://gateway.example.com",
          [host],
        ),
      ).toThrow("exact DNS hostnames");
    }
  });
});
