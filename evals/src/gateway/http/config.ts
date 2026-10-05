import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessHttpConfig, HarnessRoutePath } from "./types.js";

const knownRoutes = new Set<HarnessRoutePath>([
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/responses",
  "/v1/chat/completions",
]);
const sha256Pattern = /^[0-9a-f]{64}$/i;

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HTTP gateway config must be an object");
  }
  return value as Record<string, unknown>;
}

function positiveNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

export function parseHarnessHttpConfig(value: unknown): HarnessHttpConfig {
  const input = asObject(value);
  if (input.schemaVersion !== 1) throw new Error("unsupported HTTP gateway config schema");

  if (!Array.isArray(input.enabledRoutes)) {
    throw new Error("enabledRoutes must be an array");
  }
  const enabledRoutes = input.enabledRoutes.map((route) => {
    if (typeof route !== "string" || !knownRoutes.has(route as HarnessRoutePath)) {
      throw new Error(`unknown enabled route: ${String(route)}`);
    }
    return route as HarnessRoutePath;
  });
  if (new Set(enabledRoutes).size !== enabledRoutes.length) {
    throw new Error("enabledRoutes may not contain duplicates");
  }

  const evidence = asObject(input.routeEvidence ?? {});
  const chatEvidence = evidence.chatCompletionsTranscriptSha256;
  if (chatEvidence !== undefined && (typeof chatEvidence !== "string" || !sha256Pattern.test(chatEvidence))) {
    throw new Error("Chat Completions transcript evidence must be a SHA-256 digest");
  }
  if (
    enabledRoutes.includes("/v1/chat/completions") &&
    typeof chatEvidence !== "string"
  ) {
    throw new Error("Chat Completions requires transcript evidence before enablement");
  }

  const routeEvidence =
    typeof chatEvidence === "string"
      ? { chatCompletionsTranscriptSha256: chatEvidence }
      : {};

  return {
    schemaVersion: 1,
    maxBodyBytes: positiveNumber(input, "maxBodyBytes"),
    ratePerMinute: positiveNumber(input, "ratePerMinute"),
    rateBurst: positiveNumber(input, "rateBurst"),
    nonStreamingTimeoutMs: positiveNumber(input, "nonStreamingTimeoutMs"),
    firstResponseTimeoutMs: positiveNumber(input, "firstResponseTimeoutMs"),
    streamIdleTimeoutMs: positiveNumber(input, "streamIdleTimeoutMs"),
    maxStreamDurationMs: positiveNumber(input, "maxStreamDurationMs"),
    reconciliationTimeoutMs: positiveNumber(input, "reconciliationTimeoutMs"),
    reconciliationInitialDelayMs: positiveNumber(input, "reconciliationInitialDelayMs"),
    reconciliationMaxDelayMs: positiveNumber(input, "reconciliationMaxDelayMs"),
    costToleranceUsd: positiveNumber(input, "costToleranceUsd"),
    enabledRoutes,
    routeEvidence,
  };
}

export async function loadHarnessHttpConfig(
  path = resolve(process.cwd(), "evals/config/http-gateway.json"),
): Promise<HarnessHttpConfig> {
  return parseHarnessHttpConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
}
