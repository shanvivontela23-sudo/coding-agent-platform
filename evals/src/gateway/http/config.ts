import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HarnessHttpConfig } from "./types.js";

const limitsSchema = z.object({
  maxBodyBytes: z.number().int().positive(),
  ratePerMinute: z.number().positive(),
  rateBurst: z.number().int().positive(),
  nonStreamingTimeoutMs: z.number().int().positive(),
  firstResponseTimeoutMs: z.number().int().positive(),
  streamIdleTimeoutMs: z.number().int().positive(),
  maxStreamDurationMs: z.number().int().positive(),
  reconciliationTimeoutMs: z.number().int().positive(),
  reconciliationInitialDelayMs: z.number().int().positive(),
  reconciliationMaxDelayMs: z.number().int().positive(),
  costToleranceUsd: z.number().positive(),
});

const routeSchema = z.object({
  method: z.literal("POST"),
  path: z.string().startsWith("/"),
  wireApi: z.enum(["chat-completions", "responses", "anthropic-messages"]),
  enabled: z.boolean(),
  streamingAllowed: z.boolean(),
  paid: z.boolean(),
  modelField: z.literal("model"),
  forwardRequestHeaders: z.array(z.string().min(1)),
  safeResponseHeaders: z.array(z.string().min(1)),
  modelSettingFields: z.array(z.string().min(1)),
});

const configSchema = z.object({
  limits: limitsSchema,
  routes: z.array(routeSchema).min(1),
  routeEvidence: z.object({
    chatCompletionsTranscriptSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
  }),
});

const configUrl = new URL("../../../config/http-gateway.json", import.meta.url);

function readCommittedConfig(): unknown {
  return JSON.parse(readFileSync(configUrl, "utf8")) as unknown;
}

export function loadHarnessHttpConfig(input: unknown = readCommittedConfig()): HarnessHttpConfig {
  const config = configSchema.parse(input);
  const chatRoute = config.routes.find(
    (route) => route.path === "/v1/chat/completions",
  );
  if (
    chatRoute?.enabled &&
    !config.routeEvidence.chatCompletionsTranscriptSha256
  ) {
    throw new Error(
      "Chat Completions requires a recorded harness transcript SHA-256 before it can be enabled",
    );
  }

  const identities = new Set<string>();
  for (const route of config.routes) {
    const identity = `${route.method} ${route.path}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate harness route: ${identity}`);
    }
    identities.add(identity);
  }

  return config;
}
