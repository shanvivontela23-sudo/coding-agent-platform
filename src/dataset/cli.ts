import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateDatasetManifest } from "./validate.js";

async function main(): Promise<void> {
  const path = process.argv[2];

  if (!path) {
    console.error("Usage: pnpm dataset:validate <manifest.json>");
    process.exitCode = 2;
    return;
  }

  try {
    const content = await readFile(resolve(path), "utf8");
    const input: unknown = JSON.parse(content);
    const result = validateDatasetManifest(input);

    if (result.ok) {
      console.log(
        `Valid Phase 0 dataset: ${result.manifest.tasks.length} tasks, ${result.manifest.adversarialCases.length} adversarial cases.`,
      );
      return;
    }

    for (const issue of result.issues) {
      const location = issue.path ? ` (${issue.path})` : "";
      console.error(`[${issue.code}]${location} ${issue.message}`);
    }
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
