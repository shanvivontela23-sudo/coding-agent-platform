import { E2B } from "e2b";
import {
  networkPolicyForPhase,
  toE2BCreateNetwork,
} from "../src/sandbox/network-policy.js";
import {
  E2B_NETWORK_SMOKE_ASSERTIONS,
  requireLiveSmoke,
  writeSmokeEvidence,
  type SmokeAssertionId,
  type SmokeEvidenceRow,
} from "./contracts.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for E2B live smoke`);
  return value;
}

function httpsGatewayUrl(): string {
  const value = requiredEnv("SMOKE_GATEWAY_BASE_URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("SMOKE_GATEWAY_BASE_URL must be an HTTPS URL with a hostname");
  }
  return url.toString().replace(/\/$/, "");
}

function pythonReachabilityCommand(url: string): string {
  const encoded = JSON.stringify(url);
  return [
    "python -c '",
    "import ssl,sys,urllib.request; ",
    "from urllib.error import HTTPError; ",
    `u=${encoded}; `,
    "ctx=ssl._create_unverified_context(); ",
    "\ntry:\n urllib.request.urlopen(u, timeout=8, context=ctx); sys.exit(0)",
    "\nexcept HTTPError:\n sys.exit(0)",
    "\nexcept Exception:\n sys.exit(7)'",
  ].join("");
}

async function main(): Promise<void> {
  requireLiveSmoke();
  const gatewayUrl = httpsGatewayUrl();
  const apiKey = requiredEnv("E2B_API_KEY");
  const client = new E2B({ apiKey });
  const evidence: SmokeEvidenceRow[] = [];
  const policy = networkPolicyForPhase("coding", gatewayUrl);
  const sandbox = await client.Sandbox.create({
    template: process.env.SMOKE_E2B_TEMPLATE?.trim() || "base",
    timeoutMs: 10 * 60_000,
    metadata: { purpose: "phase0-network-smoke" },
    network: toE2BCreateNetwork(policy),
    lifecycle: { onTimeout: "kill", autoResume: false },
  });

  const record = async (
    assertion: SmokeAssertionId,
    operation: () => Promise<Readonly<Record<string, unknown>> | void>,
  ): Promise<void> => {
    try {
      const detail = await operation();
      evidence.push({ assertion, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      evidence.push({
        assertion,
        ok: false,
        detail: { error: error instanceof Error ? error.message : "network assertion failed" },
      });
    }
  };

  const probe = async (url: string): Promise<number> => {
    try {
      const result = await sandbox.commands.run(pythonReachabilityCommand(url), {
        timeoutMs: 15_000,
      });
      return result.exitCode;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "exitCode" in error &&
        typeof (error as { exitCode?: unknown }).exitCode === "number"
      ) {
        return (error as { exitCode: number }).exitCode;
      }
      throw error;
    }
  };

  try {
    await record("gateway_https_reachable", async () => {
      const exitCode = await probe(gatewayUrl);
      if (exitCode !== 0) throw new Error(`gateway probe exit code ${exitCode}`);
      return { reachable: true };
    });

    for (const [assertion, url] of [
      ["non_allowlisted_hostname_blocked", "https://example.com/"],
      ["raw_ipv4_blocked", "https://1.1.1.1/"],
      ["outside_dns_name_blocked", "https://www.google.com/"],
      ["ipv6_egress_blocked", "https://[2606:4700:4700::1111]/"],
    ] as const) {
      await record(assertion, async () => {
        const exitCode = await probe(url);
        if (exitCode === 0) throw new Error(`${url} was reachable from coding-phase sandbox`);
        return { blocked: true, exitCode };
      });
    }
  } finally {
    await sandbox.kill().catch(() => undefined);
  }

  const missing = E2B_NETWORK_SMOKE_ASSERTIONS.filter(
    (assertion) => !evidence.some((row) => row.assertion === assertion),
  );
  for (const assertion of missing) {
    evidence.push({ assertion, ok: false, detail: { error: "assertion was not executed" } });
  }

  const path = await writeSmokeEvidence("e2b-network-live", evidence);
  const failed = evidence.filter((row) => !row.ok);
  console.log(`E2B network smoke evidence: ${path}; passed=${evidence.length - failed.length}; failed=${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "E2B network live smoke failed");
  process.exitCode = 1;
});
