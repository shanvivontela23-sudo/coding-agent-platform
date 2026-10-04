import { z } from "zod";
import { difficultySchema, stackSchema } from "./run-result.js";

const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "expected a Git commit SHA");

export const sealedArtifactSchema = z.object({
  artifactId: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, "expected a SHA-256 digest"),
});

export const taskSchema = z
  .object({
    id: z.string().min(1),
    stack: stackSchema,
    difficulty: difficultySchema,
    split: z.enum(["development", "held-out"]),
    repository: z.object({
      url: z.string().url(),
      pinnedCommit: commitShaSchema,
    }),
    source: z.object({
      issueUrl: z.string().url(),
      issueId: z.string().min(1),
      originalTitle: z.string().min(1),
    }),
    ticket: z.object({
      developmentText: z.string().min(1).optional(),
      sealedArtifact: sealedArtifactSchema.optional(),
    }),
    reference: z.object({
      fixCommit: commitShaSchema,
      files: z.array(z.string().min(1)).min(1),
      diffLines: z.number().int().positive(),
      mergeDate: z.string().date(),
      hiddenTestsArtifact: sealedArtifactSchema,
    }),
  })
  .superRefine((task, context) => {
    if (task.repository.pinnedCommit === task.reference.fixCommit) {
      context.addIssue({
        code: "custom",
        message: "pinnedCommit must be the commit before the reference fix",
        path: ["repository", "pinnedCommit"],
      });
    }

    if (task.split === "development" && !task.ticket.developmentText) {
      context.addIssue({
        code: "custom",
        message: "development tasks require developmentText",
        path: ["ticket", "developmentText"],
      });
    }

    if (task.split === "held-out") {
      if (task.ticket.developmentText) {
        context.addIssue({
          code: "custom",
          message: "held-out ticket text must not be stored in the public manifest",
          path: ["ticket", "developmentText"],
        });
      }

      if (!task.ticket.sealedArtifact) {
        context.addIssue({
          code: "custom",
          message: "held-out tasks require a sealed ticket artifact",
          path: ["ticket", "sealedArtifact"],
        });
      }
    }
  });

export type BenchmarkTask = z.infer<typeof taskSchema>;
