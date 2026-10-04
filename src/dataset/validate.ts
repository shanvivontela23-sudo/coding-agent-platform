import {
  adversarialExpectedBehaviorByKind,
  type AdversarialKind,
} from "../domain/adversarial-case.js";
import type { DatasetManifest } from "../domain/dataset.js";
import { datasetManifestSchema } from "../domain/dataset.js";

export type DatasetValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type DatasetValidationResult =
  | { ok: true; manifest: DatasetManifest }
  | { ok: false; issues: DatasetValidationIssue[] };

const stacks = [
  "typescript-node",
  "python",
  "java-spring",
  "dotnet",
] as const;

const expectedDifficultyCounts = {
  easy: 4,
  medium: 4,
  hard: 2,
} as const;

function fromZodIssue(issue: { message: string; path: readonly PropertyKey[] }): DatasetValidationIssue {
  return {
    code: "schema",
    message: issue.message,
    ...(issue.path.length > 0 ? { path: issue.path.map(String).join(".") } : {}),
  };
}

function countBy<T>(values: T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = key(value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function validateDatasetManifest(input: unknown): DatasetValidationResult {
  const parsed = datasetManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(fromZodIssue) };
  }

  const manifest = parsed.data;
  const issues: DatasetValidationIssue[] = [];

  const ids = [
    ...manifest.tasks.map((task) => task.id),
    ...manifest.adversarialCases.map((entry) => entry.id),
  ];
  const idCounts = countBy(ids, (id) => id);
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        code: "duplicate-id",
        message: `dataset id "${id}" occurs ${count} times`,
      });
    }
  }

  if (manifest.tasks.length !== 40) {
    issues.push({
      code: "task-count",
      message: `expected 40 benchmark tasks, found ${manifest.tasks.length}`,
    });
  }

  if (manifest.adversarialCases.length !== 8) {
    issues.push({
      code: "adversarial-count",
      message: `expected 8 adversarial cases, found ${manifest.adversarialCases.length}`,
    });
  }

  for (const stack of stacks) {
    const tasks = manifest.tasks.filter((task) => task.stack === stack);
    if (tasks.length !== 10) {
      issues.push({
        code: "stack-task-count",
        message: `${stack}: expected 10 tasks, found ${tasks.length}`,
      });
    }

    for (const [difficulty, expected] of Object.entries(expectedDifficultyCounts)) {
      const actual = tasks.filter((task) => task.difficulty === difficulty).length;
      if (actual !== expected) {
        issues.push({
          code: "difficulty-count",
          message: `${stack}: expected ${expected} ${difficulty} tasks, found ${actual}`,
        });
      }
    }

    const development = tasks.filter((task) => task.split === "development").length;
    const heldOut = tasks.filter((task) => task.split === "held-out").length;
    if (development !== 7 || heldOut !== 3) {
      issues.push({
        code: "split-count",
        message: `${stack}: expected 7 development and 3 held-out tasks, found ${development} and ${heldOut}`,
      });
    }

    const adversarial = manifest.adversarialCases.filter(
      (entry) => entry.stack === stack,
    ).length;
    if (adversarial !== 2) {
      issues.push({
        code: "stack-adversarial-count",
        message: `${stack}: expected 2 adversarial cases, found ${adversarial}`,
      });
    }
  }

  const kinds: AdversarialKind[] = [
    "readme-instruction",
    "code-comment-instruction",
    "ticket-instruction",
    "missing-information",
    "contradictory-ticket",
    "cannot-reproduce",
    "scope-creep",
    "malicious-dependency-prompt",
  ];

  const kindCounts = countBy(
    manifest.adversarialCases,
    (entry) => entry.kind,
  );

  for (const kind of kinds) {
    if ((kindCounts.get(kind) ?? 0) !== 1) {
      issues.push({
        code: "adversarial-kind-count",
        message: `expected exactly one adversarial case of kind ${kind}`,
      });
    }
  }

  for (const entry of manifest.adversarialCases) {
    const expected = adversarialExpectedBehaviorByKind[entry.kind];
    if (entry.expectedBehavior !== expected) {
      issues.push({
        code: "adversarial-behavior",
        message: `${entry.kind}: expected behavior ${expected}, found ${entry.expectedBehavior}`,
      });
    }
  }

  return issues.length === 0
    ? { ok: true, manifest }
    : { ok: false, issues };
}
