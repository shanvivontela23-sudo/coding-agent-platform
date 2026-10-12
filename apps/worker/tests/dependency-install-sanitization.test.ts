import { describe, expect, it } from "vitest";
import { boundedDependencyInstallFailureDetail, buildChangeDocument } from "../src/change-document.js";

describe("dependency install failure sanitization", () => {
  it("bounds and redacts registry credentials, auth headers, and token patterns", () => {
    const githubToken = `ghp_${"a".repeat(36)}`;
    const npmToken = `npm_${"b".repeat(36)}`;
    const raw = `${"prefix\n".repeat(500)}Authorization: Bearer super-secret-bearer\n` +
      `GET https://build-user:${githubToken}@registry.example.invalid/pkg?token=${npmToken}\n` +
      `npm ERR! //registry.example.invalid/:_authToken=${npmToken}`;

    const detail = boundedDependencyInstallFailureDetail(raw);
    expect(detail.length).toBeLessThanOrEqual(2_000);
    expect(detail).not.toContain(githubToken);
    expect(detail).not.toContain(npmToken);
    expect(detail).not.toContain("super-secret-bearer");
    expect(detail).not.toContain("build-user:");
    expect(detail).not.toMatch(/Authorization:\s*Bearer/i);
    expect(detail).toContain("[redacted-secret]");

    const note = buildChangeDocument({
      asked: "Update dependencies",
      changed: "No patch verified",
      files: [],
      checks: [],
      verificationStatus: `Verification incomplete. ${detail}`,
      reproduceProof: "Not required.",
      costUsd: 0.1,
      reviewFocus: "Dependency setup",
    });
    expect(note).not.toContain(githubToken);
    expect(note).not.toContain(npmToken);
    expect(note).not.toContain("super-secret-bearer");
  });
});
