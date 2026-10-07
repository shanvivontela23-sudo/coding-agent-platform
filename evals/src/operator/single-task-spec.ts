import { z } from "zod";
import { difficultySchema, splitSchema } from "../domain/run-result.js";
import { commitShaSchema } from "../domain/task.js";

const commandSchema = z.string().min(1);

export const singleClaudeTaskSpecSchema = z.object({
  taskId: z.string().min(1),
  difficulty: difficultySchema,
  split: splitSchema,
  ticketText: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().min(1),
  repository: z.object({
    pinnedCommit: commitShaSchema,
    archivePath: z.string().min(1),
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  }),
  referenceFiles: z.array(z.string().min(1)).min(1),
  referenceDiffLines: z.number().int().positive(),
  hiddenFiles: z.array(z.object({
    path: z.string().startsWith(".benchmark-hidden/"),
    sourcePath: z.string().min(1),
  })),
  commands: z.object({
    install: commandSchema,
    reproduction: commandSchema,
    reference: commandSchema,
    regression: commandSchema,
    build: commandSchema,
    lint: commandSchema,
  }),
  dependencySetupCommand: commandSchema,
  extraDependencyHosts: z.array(z.string().min(1)).optional(),
  setupTimeoutMs: z.number().int().positive().default(600_000),
  runTimeoutMs: z.number().int().positive(),
  evaluatorCommandTimeoutMs: z.number().int().positive().default(600_000),
  maxTurns: z.number().int().positive(),
  spendCapUsd: z.number().positive().max(10),
  sandboxUsdPerSecond: z.number().nonnegative(),
  runNumber: z.number().int().min(1).max(3).default(1),
}).strict();

export type SingleClaudeTaskSpec = z.infer<typeof singleClaudeTaskSpecSchema>;
