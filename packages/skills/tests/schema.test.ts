import { describe, expect, it } from "vitest";
import { estimateConservativeTokens, parseStackSkillDefinition } from "../src/schema.js";

function validDefinition(): Record<string, unknown> {
  return {
    id: "typescript-node",
    version: "1.0.0",
    displayName: "TypeScript / Node",
    detect: { manifests: ["package.json"], markers: ["typescript", "javascript"] },
    sandboxTemplateKey: "typescript-node",
    defaults: {
      install: { pnpm: "pnpm install --frozen-lockfile", npm: "npm ci" },
      build: { pnpm: "pnpm build", npm: "npm run build" },
      test: { pnpm: "pnpm test", npm: "npm test" },
      testRunner: { vitest: { pnpm: "pnpm exec vitest run", npm: "npm exec -- vitest run" } },
      lint: { pnpm: "pnpm lint", npm: "npm run lint" },
      testSingle: {
        vitest: "{test} --run {path}",
        jest: "{test} --runTestsByPath {path}",
        mocha: "{test} {path}",
        "node:test": "{test} {path}",
      },
    },
    verification: [
      { name: "install", commandRole: "install", environmentFailurePatterns: ["command not found"] },
      { name: "test", commandRole: "test", environmentFailurePatterns: ["Cannot find module"] },
      { name: "build", commandRole: "build", environmentFailurePatterns: ["command not found"] },
    ],
    limits: { installTimeoutMs: 120_000, testTimeoutMs: 120_000, buildTimeoutMs: 120_000 },
  };
}

describe("stack skill schema", () => {
  it("parses a complete TypeScript/Node definition and attaches bounded guide metadata", () => {
    const parsed = parseStackSkillDefinition(validDefinition(), "Prefer the repository's package manager.", "fixture/skill.json");
    expect(parsed).toMatchObject({ id: "typescript-node", version: "1.0.0", displayName: "TypeScript / Node", guideTokenEstimate: 14 });
    expect(parsed.defaults.testSingle.vitest).toBe("{test} --run {path}");
    expect(parsed.defaults.testRunner.vitest?.pnpm).toBe("pnpm exec vitest run");
  });

  it("uses the gateway's conservative one-token-per-three-UTF-8-bytes estimate", () => {
    expect(estimateConservativeTokens("abcd")).toBe(2);
    expect(estimateConservativeTokens("€")).toBe(1);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixtures deliberately mutate arbitrary JSON
  type MutableDefinition = Record<string, any>;
  it.each([
    ["unknown keys", (value: Record<string, unknown>) => { value.extra = true; }],
    ["invalid id", (value: Record<string, unknown>) => { value.id = "Type Script"; }],
    ["invalid version", (value: Record<string, unknown>) => { value.version = "v1"; }],
    ["empty command", (value: MutableDefinition) => { value.defaults.test.pnpm = "  "; }],
    ["duplicate verification step", (value: MutableDefinition) => { value.verification[2].name = "test"; value.verification[2].commandRole = "test"; }],
    ["mismatched verification role", (value: MutableDefinition) => { value.verification[1].commandRole = "build"; }],
    ["malformed environment pattern", (value: MutableDefinition) => { value.verification[1].environmentFailurePatterns = ["("]; }],
    ["missing path placeholder", (value: MutableDefinition) => { value.defaults.testSingle.vitest = "{test} --run"; }],
    ["repeated path placeholder", (value: MutableDefinition) => { value.defaults.testSingle.vitest = "{test} {path} {path}"; }],
    ["unsafe multiline template", (value: MutableDefinition) => { value.defaults.testSingle.vitest = "{test} {path}\nwhoami"; }],
    ["non-positive limit", (value: MutableDefinition) => { value.limits.testTimeoutMs = 0; }],
  ])("rejects %s", (_name, mutate) => {
    const value = validDefinition();
    mutate(value);
    expect(() => parseStackSkillDefinition(value, "guide", "fixture/skill.json")).toThrow(/fixture\/skill\.json/);
  });

  it("rejects a guide over the hard 1,500-token cap without echoing the guide", () => {
    const secret = "DO_NOT_ECHO_SECRET";
    const guide = `${"x".repeat(4_500)}${secret}`;
    expect(() => parseStackSkillDefinition(validDefinition(), guide, "fixture/skill.json")).toThrow(/1,500 token/i);
    try {
      parseStackSkillDefinition(validDefinition(), guide, "fixture/skill.json");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
