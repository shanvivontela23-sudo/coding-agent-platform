import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDependencyBaselineCommand } from "../src/sandbox/repository-bootstrap.js";

// Live run 2026-10-13: the exported patch added package-lock.json created by
// npm install, so it failed to apply on the verification copy (which installs
// first). Patches must be diffed against the post-install commit.
describe("dependency baseline", () => {
  it("commits the post-install tree and prints the new HEAD", () => {
    const lines = buildDependencyBaselineCommand().split("\n");
    expect(lines).toContain("git add -A");
    expect(lines.some((line) => line.startsWith("git commit") && line.includes("--allow-empty"))).toBe(true);
    expect(lines.at(-1)).toBe("git rev-parse HEAD");
  });

  it("leaves install-created files out of a patch diffed from that commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "dhara-depbase-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, "refund.js"), "total += item.unitPrice;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    writeFileSync(join(repo, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "dependencies installed");
    const dependencyBaseline = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "refund.js"), "total += item.unitPrice * returned.quantity;\n");
    git("add", "--intent-to-add", "-A");
    const patch = git("diff", "--binary", "--no-ext-diff", dependencyBaseline, "--");
    expect(patch).toContain("refund.js");
    expect(patch).not.toContain("package-lock.json");
  });
});
