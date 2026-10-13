import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepositoryBootstrapCommand, dependencyExcludes } from "../src/sandbox/repository-bootstrap.js";

const sha = "a".repeat(40);

// Live run 2026-10-13: a 6-file ZIP with no .gitignore produced a 2.5 MB
// patch because npm install output was exported as part of the change.
describe("bootstrap dependency excludes", () => {
  it("writes dependency folders to the synthetic repo's local exclude file after git init", () => {
    const command = buildRepositoryBootstrapCommand(sha);
    const lines = command.split("\n");
    const init = lines.indexOf("git init -q");
    const exclude = lines.findIndex((line) => line.includes(">> .git/info/exclude"));
    expect(init).toBeGreaterThan(-1);
    expect(exclude).toBeGreaterThan(init);
    for (const entry of ["node_modules/", ".venv/", "__pycache__/"]) expect(lines[exclude]).toContain(`'${entry}'`);
  });

  it("keeps node_modules out of git status in a real repo using the same exclude list", () => {
    const repo = mkdtempSync(join(tmpdir(), "dhara-exclude-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, ".git", "info", "exclude"), `${dependencyExcludes.join("\n")}\n`, { flag: "a" });
    writeFileSync(join(repo, "refund.js"), "module.exports = 1;\n");
    mkdirSync(join(repo, "node_modules", "express"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "express", "index.js"), "x".repeat(10_000));
    const status = git("status", "--porcelain=v1", "--untracked-files=all");
    expect(status).toContain("refund.js");
    expect(status).not.toContain("node_modules");
  });
});
