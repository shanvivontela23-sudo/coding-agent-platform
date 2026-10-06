import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function readCommittedConfig(): unknown {
  const path = join(process.cwd(), "evals", "config", "http-gateway.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadHarnessHttpConfig(
  input: unknown = readCommittedConfig(),
): HarnessHttpConfig {
  const parsed = configSchema.parse(input);
  const chatRoute = parsed.routes.find(
    (route) => route.path === "/v1/chat/completions",
  );
  if (
    chatRoute?.enabled &&
    !parsed.routeEvidence.chatCompletionsTranscriptSha256
  ) {
    throw new Error(
      "Chat Completions requires a recorded harness transcript SHA-256 before it can be enabled",
    );
  }

  const identities = new Set<string>();
  for (const route of parsed.routes) {
    const identity = `${route.method} ${route.path}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate harness route: ${identity}`);
    }
    identities.add(identity);
  }

  return {
    limits: parsed.limits,
    routes: parsed.routes,
    routeEvidence: parsed.routeEvidence.chatCompletionsTranscriptSha256
      ? {
          chatCompletionsTranscriptSha256:
            parsed.routeEvidence.chatCompletionsTranscriptSha256,
        }
      : {},
  };
}
