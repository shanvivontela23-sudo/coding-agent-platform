import { describe, expect, it } from "vitest";
import { heldOutTaskArtifactPayloadSchema } from "../src/domain/task.js";
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

function developmentTask(
  stack: (typeof stacks)[number],
  index: number,
  difficulty: (typeof difficulties)[number],
) {
  return {
    id: `${stack}-${index + 1}`,
    stack,
    difficulty,
    split: "development" as const,
    repository: {
      url: "https://github.com/example/example-app",
      pinnedCommit: "1".repeat(40),
    },
    source: {
      issueUrl: `https://github.com/example/example-app/issues/${index + 1}`,
      issueId: String(index + 1),
      originalTitle: `Bug ${index + 1}`,
    },
    ticket: {
      developmentText: `Customer-visible symptom ${index + 1}`,
    },
    reference: {
      fixCommit: "2".repeat(40),
      files: ["src/example.ts"],
      diffLines: 12,
      mergeDate: "2026-09-01",
      hiddenTestsArtifact: artifact(`tests-${stack}-${index + 1}`),
    },
  };
}

function heldOutTask(
  stack: (typeof stacks)[number],
  index: number,
  difficulty: (typeof difficulties)[number],
) {
  return {
    id: `${stack}-${index + 1}`,
    stack,
    difficulty,
    split: "held-out" as const,
    repository: {
      url: "https://github.com/example/example-app",
      pinnedCommit: "1".repeat(40),
    },
    heldOutArtifact: artifact(`held-out-${stack}-${index + 1}`),
  };
}

function validManifest(): DatasetManifest {
  const tasks: DatasetManifest["tasks"] = [];

  for (const stack of stacks) {
    for (let index = 0; index < 10; index += 1) {
      const difficulty = difficulties[index]!;
      tasks.push(
        heldOutIndexes.has(index)
          ? heldOutTask(stack, index, difficulty)
          : developmentTask(stack, index, difficulty),
      );
    }
  }

  const adversarialCases: DatasetManifest["adversarialCases"] = [
    {
      id: "adv-1",
      stack: "typescript-node",
      kind: "readme-instruction",
      fixtureArtifact: artifact("adv-fixture-1"),
      expectedBehavior: "ignore-instruction",
    },
    {
      id: "adv-2",
      stack: "typescript-node",
      kind: "code-comment-instruction",
      fixtureArtifact: artifact("adv-fixture-2"),
      expectedBehavior: "ignore-instruction",
    },
    {
      id: "adv-3",
      stack: "python",
      kind: "ticket-instruction",
      fixtureArtifact: artifact("adv-fixture-3"),
      expectedBehavior: "fix-or-stop",
    },
    {
      id: "adv-4",
      stack: "python",
      kind: "missing-information",
      fixtureArtifact: artifact("adv-fixture-4"),
      expectedBehavior: "ask",
    },
    {
      id: "adv-5",
      stack: "java-spring",
      kind: "contradictory-ticket",
      fixtureArtifact: artifact("adv-fixture-5"),
      expectedBehavior: "ask",
    },
    {
      id: "adv-6",
      stack: "java-spring",
      kind: "cannot-reproduce",
      fixtureArtifact: artifact("adv-fixture-6"),
      expectedBehavior: "report-no-repro",
    },
    {
      id: "adv-7",
      stack: "dotnet",
      kind: "scope-creep",
      fixtureArtifact: artifact("adv-fixture-7"),
      expectedBehavior: "fix-without-scope-creep",
    },
    {
      id: "adv-8",
      stack: "dotnet",
      kind: "malicious-dependency-prompt",
      fixtureArtifact: artifact("adv-fixture-8"),
      expectedBehavior: "do-not-install",
    },
  ];

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

function mutableInput(): Record<string, unknown> {
  return structuredClone(validManifest()) as unknown as Record<string, unknown>;
}

describe("validateDatasetManifest", () => {
  it("accepts the required 40-task and 8-adversarial shape", () => {
    const result = validateDatasetManifest(validManifest());

    expect(result.ok).toBe(true);
  });

  it("keeps held-out source and reference metadata out of the public manifest", () => {
    const input = mutableInput();
    const tasks = input.tasks as Array<Record<string, unknown>>;
    const heldOut = tasks.find((task) => task.split === "held-out");
    if (!heldOut) throw new Error("fixture error");

    heldOut.source = {
      issueUrl: "https://github.com/example/example-app/issues/99",
      issueId: "99",
      originalTitle: "Leaked bug title",
    };

    const result = validateDatasetManifest(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.code === "schema" &&
            issue.message.toLowerCase().includes("unrecognized"),
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

  it("rejects non-40-character pinned commit SHAs", () => {
    const input = mutableInput();
    const tasks = input.tasks as Array<Record<string, unknown>>;
    const repository = tasks[0]!.repository as Record<string, unknown>;
    repository.pinnedCommit = "1".repeat(39);

    const result = validateDatasetManifest(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) =>
          issue.message.includes("40-character Git commit SHA"),
        ),
      ).toBe(true);
    }
  });

  it("rejects non-40-character fix SHAs in sealed held-out payloads", () => {
    const result = heldOutTaskArtifactPayloadSchema.safeParse({
      ticketText: "The customer sees the wrong total after applying a coupon.",
      source: {
        issueUrl: "https://github.com/example/example-app/issues/12",
        issueId: "12",
        originalTitle: "Coupon total is wrong",
      },
      reference: {
        fixCommit: "2".repeat(39),
        files: ["src/checkout.ts"],
        diffLines: 9,
        mergeDate: "2026-09-01",
        hiddenTestsArtifact: artifact("hidden-tests"),
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an adversarial kind paired with the wrong expected behavior", () => {
    const manifest = validManifest();
    manifest.adversarialCases[0]!.expectedBehavior = "ask";

    const result = validateDatasetManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.code === "adversarial-behavior"),
      ).toBe(true);
    }
  });
});
