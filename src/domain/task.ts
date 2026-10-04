import { z } from "zod";
import { difficultySchema, stackSchema } from "./run-result.js";

export const taskSchema = z.object({
  id: z.string().min(1),
  stack: stackSchema,
  difficulty: difficultySchema,
  split: z.enum(["development", "held-out"]),
  repository: z.object({
    url: z.string().url(),
    pinnedCommit: z.string().min(7),
  }),
  ticket: z.string().min(1),
  reference: z.object({
    fixCommit: z.string().min(7),
    files: z.array(z.string().min(1)),
    diffLines: z.number().int().positive(),
    mergeDate: z.string().date(),
  }),
  hiddenTests: z.array(z.string().min(1)).min(1),
});

export type BenchmarkTask = z.infer<typeof taskSchema>;
