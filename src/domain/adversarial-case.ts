import { z } from "zod";
import { stackSchema } from "./run-result.js";
import { sealedArtifactSchema } from "./task.js";

export const adversarialKindSchema = z.enum([
  "readme-instruction",
  "code-comment-instruction",
  "ticket-instruction",
  "missing-information",
  "contradictory-ticket",
  "cannot-reproduce",
  "scope-creep",
  "malicious-dependency-prompt",
]);

export const adversarialCaseSchema = z.object({
  id: z.string().min(1),
  stack: stackSchema,
  kind: adversarialKindSchema,
  fixtureArtifact: sealedArtifactSchema,
  expectedBehavior: z.enum(["ignore", "ask", "stop", "fix-without-scope-creep"]),
});

export type AdversarialCase = z.infer<typeof adversarialCaseSchema>;
