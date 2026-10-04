import { z } from "zod";
import { difficultySchema, stackSchema } from "./run-result.js";

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "expected a full 40-character Git commit SHA");

export const sealedArtifactSchema = z.object({
  artifactId: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, "expected a SHA-256 digest"),
});

const commonTaskShape = {
  id: z.string().min(1),
  stack: stackSchema,
  difficulty: difficultySchema,
  repository: z.object({
    url: z.string().url(),
    pinnedCommit: commitShaSchema,
  }),
};

export const developmentTaskSchema = z.object({
  ...commonTaskShape,
  split: z.literal("development"),
  source: z.object({
    issueUrl: z.string().url(),
    issueId: z.string().min(1),
    originalTitle: z.string().min(1),
  }),
  ticket: z.object({
    developmentText: z.string().min(1),
  }),
  reference: z.object({
    fixCommit: commitShaSchema,
    files: z.array(z.string().min(1)).min(1),
    diffLines: z.number().int().positive(),
    mergeDate: z.string().date(),
    hiddenTestsArtifact: sealedArtifactSchema,
  }),
}).strict().superRefine((task, context) => {
  if (task.repository.pinnedCommit === task.reference.fixCommit) {
    context.addIssue({
      code: "custom",
      message: "pinnedCommit must be the commit before the reference fix",
      path: ["repository", "pinnedCommit"],
    });
  }
});

export const heldOutTaskSchema = z.object({
  ...commonTaskShape,
  split: z.literal("held-out"),
  heldOutArtifact: sealedArtifactSchema,
}).strict();

/**
 * Private payload resolved only by the benchmark control plane.
 *
 * None of these fields may appear in the public held-out manifest. Keeping
 * source identity and reference-fix metadata together with the ticket prevents
 * a tuner from using the public manifest to locate the original fix.
 */
export const heldOutTaskArtifactPayloadSchema = z
  .object({
    ticketText: z.string().min(1),
    source: z.object({
      issueUrl: z.string().url(),
      issueId: z.string().min(1),
      originalTitle: z.string().min(1),
    }),
    reference: z.object({
      fixCommit: commitShaSchema,
      files: z.array(z.string().min(1)).min(1),
      diffLines: z.number().int().positive(),
      mergeDate: z.string().date(),
      hiddenTestsArtifact: sealedArtifactSchema,
    }),
  })
  .superRefine((payload, context) => {
    // The pinned commit is intentionally not duplicated inside the sealed
    // payload. Its relationship to fixCommit is checked after artifact
    // resolution, when the control plane has both values.
    if (payload.reference.files.length === 0) {
      context.addIssue({
        code: "custom",
        message: "reference files must not be empty",
        path: ["reference", "files"],
      });
    }
  });

export const taskSchema = z.discriminatedUnion("split", [
  developmentTaskSchema,
  heldOutTaskSchema,
]);

export type DevelopmentBenchmarkTask = z.infer<typeof developmentTaskSchema>;
export type HeldOutBenchmarkTask = z.infer<typeof heldOutTaskSchema>;
export type HeldOutTaskArtifactPayload = z.infer<
  typeof heldOutTaskArtifactPayloadSchema
>;
export type BenchmarkTask = z.infer<typeof taskSchema>;
