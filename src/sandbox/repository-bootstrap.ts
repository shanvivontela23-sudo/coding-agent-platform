import { createHash } from "node:crypto";
import type { PinnedRepositoryArchive } from "./types.js";

export const sandboxWorkspacePath = "/workspace/repo";
export const sandboxArchivePath = "/tmp/coding-agent-repository.tar.gz";
export const sandboxMetadataPath = "/workspace/.coding-agent";

const fullShaPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;

export function validatePinnedRepositoryArchive(
  repository: PinnedRepositoryArchive,
): void {
  if (!fullShaPattern.test(repository.pinnedCommit)) {
    throw new Error("pinnedCommit must be a full 40-character Git SHA");
  }

  if (!sha256Pattern.test(repository.archiveSha256)) {
    throw new Error("archiveSha256 must be a 64-character SHA-256 digest");
  }

  const actual = createHash("sha256").update(repository.archive).digest("hex");
  if (actual !== repository.archiveSha256.toLowerCase()) {
    throw new Error("repository archive SHA-256 does not match archiveSha256");
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the deterministic bootstrap command run after the control plane uploads
 * a GitHub-style tar.gz archive for exactly one pinned source commit.
 *
 * The original .git directory/history is never transferred into the sandbox.
 * We reject archives containing .git entries and create a new one-commit
 * synthetic repository only so coding harnesses can inspect diffs.
 */
export function buildRepositoryBootstrapCommand(
  pinnedCommit: string,
): string {
  if (!fullShaPattern.test(pinnedCommit)) {
    throw new Error("pinnedCommit must be a full 40-character Git SHA");
  }

  const commit = shellSingleQuote(pinnedCommit);

  return [
    "set -euo pipefail",
    `mkdir -p ${sandboxWorkspacePath} ${sandboxMetadataPath}`,
    `test -f ${sandboxArchivePath}`,
    `if tar -tzf ${sandboxArchivePath} | awk 'BEGIN { bad=0 } /^\\// { bad=1 } /(^|\\/)\\.\\.(\\/|$)/ { bad=1 } /(^|\\/)\\.git(\\/|$)/ { bad=1 } END { exit bad ? 0 : 1 }'; then echo "unsafe repository archive" >&2; exit 41; fi`,
    `rm -rf ${sandboxWorkspacePath:?}/* ${sandboxWorkspacePath}/.[!.]* ${sandboxWorkspacePath}/..?* 2>/dev/null || true`,
    `tar -xzf ${sandboxArchivePath} --strip-components=1 --no-same-owner --no-same-permissions -C ${sandboxWorkspacePath}`,
    `if find ${sandboxWorkspacePath} -name .git -print -quit | grep -q .; then echo "source git metadata present after extraction" >&2; exit 42; fi`,
    `printf '%s\\n' ${commit} > ${sandboxMetadataPath}/source-commit`,
    `cd ${sandboxWorkspacePath}`,
    "git init -q",
    'git config user.name "Coding Agent Benchmark"',
    'git config user.email "benchmark@invalid.local"',
    "git add -A",
    `git commit -q --allow-empty -m "benchmark baseline: ${pinnedCommit}"`,
    'test "$(git rev-list --count HEAD)" = "1"',
    'test -z "$(git remote)"',
  ].join("\n");
}

export function buildPatchExportCommand(): string {
  return [
    "set -euo pipefail",
    `cd ${sandboxWorkspacePath}`,
    "git add --intent-to-add -A",
    "git diff --binary --no-ext-diff HEAD --",
  ].join("\n");
}

export function buildStatusCommand(): string {
  return [
    "set -euo pipefail",
    `cd ${sandboxWorkspacePath}`,
    "git status --porcelain=v1 --untracked-files=all",
  ].join("\n");
}
