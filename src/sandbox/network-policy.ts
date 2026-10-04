import type {
  SandboxNetworkPhase,
  SandboxNetworkPolicy,
} from "./types.js";

export const defaultDependencyHosts = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  "downloads.gradle.org",
  "api.nuget.org",
  "globalcdn.nuget.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
] as const;

function normalizedHostname(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("gatewayUrl must use https");
  }

  if (!parsed.hostname) {
    throw new Error("gatewayUrl must include a hostname");
  }

  return parsed.hostname.toLowerCase();
}

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export function networkPolicyForPhase(
  phase: SandboxNetworkPhase,
  gatewayUrl: string,
  extraDependencyHosts: readonly string[] = [],
): SandboxNetworkPolicy {
  const gatewayHost = normalizedHostname(gatewayUrl);

  switch (phase) {
    case "locked":
      return {
        allowHosts: [],
        denyAllOtherEgress: true,
      };

    case "dependency-setup":
      return {
        allowHosts: uniqueHosts([
          ...defaultDependencyHosts,
          ...extraDependencyHosts,
        ]),
        denyAllOtherEgress: true,
      };

    case "coding":
    case "testing":
      return {
        allowHosts: [gatewayHost],
        denyAllOtherEgress: true,
      };
  }
}

export function toE2BNetwork(policy: SandboxNetworkPolicy) {
  return {
    allowOut: [...policy.allowHosts],
    denyOut: ["0.0.0.0/0"],
    allowPublicTraffic: false,
  };
}
