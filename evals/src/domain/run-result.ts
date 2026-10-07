import { z } from "zod";

export const stackSchema = z.enum([
  "typescript-node",
  "python",
  "java-spring",
  "dotnet",
]);

export const difficultySchema = z.enum(["easy", "medium", "hard"]);
export const splitSchema = z.enum(["development", "held-out", "adversarial"]);
export const runStatusSchema = z.enum(["completed", "asked", "limit-hit", "error"]);
export const scopeResultSchema = z.enum(["in-scope", "flagged", "violation"]);
export const developerVerdictSchema = z.enum([
  "approve-as-is",
  "approve-small-edits",
  "reject",
]);

export const runResultSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  stack: stackSchema,
  difficulty: difficultySchema,
  split: splitSchema,
  runNumber: z.number().int().min(1).max(3),
  instructionVersion: z.string().min(1),
  configuration: z.object({
    harness: z.string().min(1),
    harnessVersion: z.string().min(1),
    model: z.string().min(1),
    modelVersion: z.string().min(1),
    modelSettings: z.record(z.string(), z.unknown()),
    sandboxImage: z.string().min(1),
  }),
  outcome: z.object({
    status: runStatusSchema,
    limit: z.string().nullable(),
    turnsUsed: z.number().int().nonnegative(),
    wallClockSeconds: z.number().nonnegative(),
  }),
  automatic: z.object({
    reproduction: z.boolean(),
    referenceTests: z.boolean(),
    regressionTests: z.boolean(),
    build: z.boolean(),
    lint: z.boolean(),
    scope: scopeResultSchema,
    filesChanged: z.number().int().nonnegative(),
    diffLines: z.number().int().nonnegative(),
  }),
  collector: z.object({
    taskValidity: z.enum(["valid", "invalid"]),
    failure: z.object({
      step: z.string().min(1),
      stderrTail: z.string().max(2_048),
    }).nullable(),
  }).optional(),
  developer: z.object({
    correctness: z.number().int().min(0).max(2),
    repoFit: z.number().int().min(0).max(2),
    scope: z.number().int().min(0).max(2),
    testQuality: z.number().int().min(0).max(2),
    verdict: developerVerdictSchema,
    reviewMinutes: z.number().nonnegative(),
    estimatedManualMinutes: z.number().nonnegative(),
    graderId: z.string().min(1),
  }).nullable(),
  reviewer: z.object({
    verdict: z.enum(["approve", "flag"]),
    findings: z.array(z.object({
      tag: z.enum(["correctness", "scope", "style", "test", "security"]),
      detail: z.string().min(1),
    })),
    model: z.string().min(1),
    costUsd: z.number().nonnegative(),
  }).nullable(),
  safety: z.object({
    canarySeenInOutput: z.boolean(),
    connectionsOutsideAllowlist: z.boolean(),
  }),
  cost: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    modelCostUsd: z.number().nonnegative(),
    sandboxSeconds: z.number().nonnegative(),
    sandboxCostUsd: z.number().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
  }),
});

export type RunResult = z.infer<typeof runResultSchema>;
