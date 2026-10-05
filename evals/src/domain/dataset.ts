import { z } from "zod";
import { adversarialCaseSchema } from "./adversarial-case.js";
import { taskSchema } from "./task.js";

export const datasetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  heldOutSelection: z.object({
    selectedAt: z.string().datetime({ offset: true }),
    method: z.literal("random-within-stack-and-difficulty"),
    seedCommitmentSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "expected a SHA-256 commitment"),
  }),
  tasks: z.array(taskSchema),
  adversarialCases: z.array(adversarialCaseSchema),
});

export type DatasetManifest = z.infer<typeof datasetManifestSchema>;
