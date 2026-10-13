import { describe, expect, it } from "vitest";
import { codexBaseUrl } from "../src/harness/codex.js";
import { harnessErrorDetail } from "../src/harness/common.js";

// Live run 2026-10-13: Codex called https://<tunnel>/responses and the
// gateway (which serves /v1/responses) answered 404.
describe("codexBaseUrl", () => {
  it.each([
    ["https://tunnel.example.dev", "https://tunnel.example.dev/v1"],
    ["https://tunnel.example.dev/", "https://tunnel.example.dev/v1"],
    ["https://tunnel.example.dev/v1", "https://tunnel.example.dev/v1"],
    ["https://tunnel.example.dev/v1/", "https://tunnel.example.dev/v1"],
    ["https://host.example.com/gateway", "https://host.example.com/gateway/v1"],
  ])("maps %s to %s so Codex reaches /v1/responses", (input, expected) => {
    expect(codexBaseUrl(input)).toBe(expected);
    expect(`${codexBaseUrl(input)}/responses`).toMatch(/\/v1\/responses$/);
  });
});

describe("harnessErrorDetail", () => {
  it("includes Codex's JSONL failure from stdout even when stderr has only warnings", () => {
    const detail = harnessErrorDetail({
      exitCode: 1,
      stderr: "WARNING: proceeding, even though we could not create PATH aliases",
      stdout: '{"type":"thread.started"}\n{"type":"turn.failed","error":{"message":"unexpected status 404"}}\n',
    });
    expect(detail).toContain("exit 1");
    expect(detail).toContain("WARNING");
    expect(detail).toContain('"turn.failed"');
  });
});
