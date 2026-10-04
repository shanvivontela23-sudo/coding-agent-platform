import { describe, expect, it } from "vitest";
import type { DatasetManifest } from "../src/domain/dataset.js";
import { validateDatasetManifest } from "../src/dataset/validate.js";

const stacks = [
  "typescript-node",
  "python",
  "java-spring",
  "dotnet",
] as const;

const difficulties = [
  "easy",
  "easy",
  "easy",
  "easy",
  "medium",
  "medium",
  "medium",
  "medium",
  "hard",
  "hard",
] as const;

const heldOutIndexes = new Set([1, 5, 8]);

function artifact(id: string) {
  return {
    artifactId: id,
    sha256: "a".repeat(64),
  };
}

function validManifest(): DatasetManifest {
  const tasks: DatasetManifest["tasks"] = [];

  for (const stack of stacks) {
    for (let index = 0; index < 10; index += 1) {
      const split = heldOutIndexes.has(index) ? "held-out" : "development";
      tasks.push({
        id: `${stack}-${index + 1}`,
        stack,
        difficulty: difficulties[index]!,
        split,
        repository: {
          url: "https://github.com/example/example-app",
          pinnedCommit: "1".repeat(40),
        },
        source: {
          issueUrl: `https://github.com/example/example-app/issues/${index + 1}`,
          issueId: String(index + 1),
          originalTitle: `Bug ${index + 1}`,
        },
        ticket:
          split === "development"
            ? { developmentText: `Customer-visible symptom ${index + 1}` }
            : { sealedArtifact: artifact(`ticket-${stack}-${index + 1}`) },
        reference: {
          fixCommit: "2".repeat(40),
          files: ["src/example.ts"],
          diffLines: 12,
          mergeDate: "2026-09-01",
          hiddenTestsArtifact: artifact(`tests-${stack}-${index + 1}`),
        },
      });
    }
  }

  const kinds = [
    "readme-instruction",
    "code-comment-instruction",
    "ticket-instruction",
    "missing-information",
    "contradictory-ticket",
    "cannot-reproduce",
    "scope-creep",
    "malicious-dependency-prompt",
  ] as const;

  const behaviors = [
    "ignore",
    "ignore",
    "stop",
    "ask",
    "ask",
    "stop",
    "fix-without-scope-creep",
    "stop",
  ] as const;

  const adversarialCases = kinds.map((kind, index) => ({
    id: `adv-${index + 1}`,
    stack: stacks[Math.floor(index / 2)]!,
    kind,
    fixtureArtifact: artifact(`adv-fixture-${index + 1}`),
    expectedBehavior: behaviors[index]!,
  }));

  return {
    schemaVersion: 1,
    datasetId: "phase-0-v1",
    createdAt: "2026-10-03T22:00:00-07:00",
    heldOutSelection: {
      selectedAt: "2026-10-03T22:00:00-07:00",
      method: "random-within-stack-and-difficulty",
      seedCommitmentSha256: "b".repeat(64),
    },
    tasks,
    adversarialCases,
  };
}

describe("validateDatasetManifest", () => {
  it("accepts the required 40-task and 8-adversarial shape", () => {
    const result = validateDatasetManifest(validManifest());

    expect(result.ok).toBe(true);
  });

  it("rejects a stack with the wrong development/held-out split", () => {
    const manifest = validManifest();
    const heldOut = manifest.tasks.find(
      (task) => task.stack === "python" && task.split === "held-out",
    );
    if (!heldOut) throw new Error("fixture error");

    heldOut.split = "development";
    heldOut.ticket = { developmentText: "now visible" };

    const result = validateDatasetManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === "split-count")).toBe(
        true,
      );
    }
  });

  it("rejects held-out ticket text in the public manifest", () => {
    const manifest = validManifest();
    const heldOut = manifest.tasks.find((task) => task.split === "held-out");
    if (!heldOut) throw new Error("fixture error");

    heldOut.ticket.developmentText = "this must remain sealed";

    const result = validateDatasetManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) =>
          issue.message.includes("held-out ticket text"),
        ),
      ).toBe(true);
    }
  });

  it("rejects duplicate identifiers across tasks and adversarial cases", () => {
    const manifest = validManifest();
    manifest.adversarialCases[0]!.id = manifest.tasks[0]!.id;

    const result = validateDatasetManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === "duplicate-id")).toBe(
        true,
      );
    }
  });
});
