import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildArchiveVerificationCommand,
  buildBaselineCommitCommand,
  buildPatchExportCommand,
  buildRepositoryBootstrapCommand,
  validateBaselineCommitSha,
  validatePinnedRepositoryArchive,
} from "../src/sandbox/repository-bootstrap.js";

describe("repository bootstrap", () => {
  it("validates the archive digest before upload", () => {
    const archive = new TextEncoder().encode("repository archive");
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");

    expect(() =>
      validatePinnedRepositoryArchive({
        pinnedCommit: "a".repeat(40),
        archiveSha256,
        archive,
      }),
    ).not.toThrow();

    expect(() =>
      validatePinnedRepositoryArchive({
        pinnedCommit: "a".repeat(40),
        archiveSha256: "b".repeat(64),
        archive,
      }),
    ).toThrow("repository archive SHA-256 does not match");
  });

  it("requires full commit SHAs", () => {
    const archive = new Uint8Array();
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");

    expect(() =>
      validatePinnedRepositoryArchive({
        pinnedCommit: "a".repeat(39),
        archiveSha256,
        archive,
      }),
    ).toThrow("40-character Git SHA");
  });

  it("builds a history-free synthetic Git baseline", () => {
    const command = buildRepositoryBootstrapCommand("a".repeat(40));

    expect(command).toContain("tar -tzf");
    expect(command).toContain("\\.git");
    expect(command).toContain("git init -q");
    expect(command).toContain('git rev-list --count HEAD');
    expect(command).toContain('test -z "$(git remote)"');
    expect(command).not.toContain("git clone");
    expect(command).not.toContain("git fetch");
    expect(command).not.toContain("git checkout");
  });

  it("records the synthetic baseline SHA explicitly", () => {
    expect(buildBaselineCommitCommand()).toContain("git rev-parse HEAD");
    expect(validateBaselineCommitSha(`  ${"A".repeat(40)}\n`)).toBe(
      "a".repeat(40),
    );
    expect(() => validateBaselineCommitSha("HEAD")).toThrow(
      "baseline commit must be a full 40-character Git SHA",
    );
  });

  it("exports patches from the recorded baseline rather than HEAD", () => {
    const baseline = "d".repeat(40);
    const command = buildPatchExportCommand(baseline);

    expect(command).toContain(`git diff --binary --no-ext-diff ${baseline} --`);
    expect(command).not.toContain("git diff --binary --no-ext-diff HEAD --");
  });

  it("builds an in-sandbox SHA-256 verification command", () => {
    const command = buildArchiveVerificationCommand("c".repeat(64));

    expect(command).toContain("sha256sum -c -");
    expect(command).toContain("c".repeat(64));
  });
});
