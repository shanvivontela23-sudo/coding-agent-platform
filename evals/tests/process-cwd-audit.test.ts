import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const roots = ["apps", "evals/src", "packages"];

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe("temporary process.cwd source audit", () => {
  it("prints every process.cwd() occurrence in requested source trees", () => {
    const matches = roots
      .flatMap(sourceFiles)
      .filter((path) => path.includes("/src/") || path.startsWith("evals/src/"))
      .flatMap((path) => {
        const lines = readFileSync(path, "utf8").split("\n");
        return lines.flatMap((line, index) => line.includes("process.cwd()") ? [`${relative(process.cwd(), path)}:${index + 1}:${line.trim()}`] : []);
      });

    console.log(`PROCESS_CWD_AUDIT=${JSON.stringify(matches)}`);
    expect(true).toBe(true);
  });
});
