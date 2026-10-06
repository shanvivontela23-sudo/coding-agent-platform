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
  "plugins-artifacts.gradle.org",
  "api.nuget.org",
  "globalcdn.nuget.org",
] as const;

const denyAllCidrs = ["0.0.0.0/0", "::/0"] as const;

function normalizedGatewayHostname(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("gatewayUrl must use https");
  }

  if (!parsed.hostname) {
    throw new Error("gatewayUrl must include a hostname");
  }

  return parsed.hostname.toLowerCase();
}

function normalizeExplicitHostname(host: string): string {
  const normalized = host.trim().toLowerCase();

  if (
    normalized.length === 0 ||
    normalized.includes("*") ||
    normalized.includes("/") ||
    normalized.includes(":") ||
    normalized.includes(" ") ||
    normalized === "localhost" ||
    normalized === "0.0.0.0"
  ) {
    throw new Error(
      `dependency egress entries must be exact DNS hostnames: ${host}`,
    );
  }

  const labels = normalized.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error(
      `dependency egress entries must be exact DNS hostnames: ${host}`,
    );
  }

  return normalized;
}

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((host) => normalizeExplicitHostname(host)))];
}

export function networkPolicyForPhase(
  phase: SandboxNetworkPhase,
  gatewayUrl: string,
  extraDependencyHosts: readonly string[] = [],
): SandboxNetworkPolicy {
  const gatewayHost = normalizedGatewayHostname(gatewayUrl);

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

export function toE2BCreateNetwork(policy: SandboxNetworkPolicy) {
  return {
    allowOut: [...policy.allowHosts],
    denyOut: [...denyAllCidrs],
    allowPublicTraffic: false,
  };
}

export function toE2BEgressUpdate(policy: SandboxNetworkPolicy) {
  return {
    allowOut: [...policy.allowHosts],
    denyOut: [...denyAllCidrs],
  };
}
