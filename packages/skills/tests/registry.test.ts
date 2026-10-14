import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadBuiltInStackSkills, loadStackSkillsFromDirectory } from "../src/registry.js";

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

const definition = {
  id: "typescript-node",
  version: "1.0.0",
  displayName: "TypeScript / Node",
  detect: { manifests: ["package.json"], markers: ["typescript"] },
  sandboxTemplateKey: "typescript-node",
  defaults: {
    install: { pnpm: "pnpm install --frozen-lockfile" },
    build: { pnpm: "pnpm build" },
    test: { pnpm: "pnpm test" },
    lint: { pnpm: "pnpm lint" },
    testSingle: { vitest: "{test} --run {path}" },
  },
  verification: [
    { name: "install", commandRole: "install", environmentFailurePatterns: ["command not found"] },
    { name: "test", commandRole: "test", environmentFailurePatterns: ["Cannot find module"] },
    { name: "build", commandRole: "build", environmentFailurePatterns: ["command not found"] },
  ],
};

async function writeSkill(root: string, directory: string, value: unknown, guide = "trusted guide"): Promise<void> {
  const skillDirectory = join(root, directory);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "skill.json"), JSON.stringify(value), "utf8");
  await writeFile(join(skillDirectory, "guide.md"), guide, "utf8");
}

describe("stack skill registry", () => {
  it("loads every committed built-in independently of process.cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dhara-skills-cwd-"));
    process.chdir(outside);
    const registry = await loadBuiltInStackSkills();
    expect([...registry.keys()]).toEqual(["dotnet", "java-spring", "python", "typescript-node"]);
    expect(registry.get("typescript-node")).toMatchObject({ version: "1.0.0", displayName: "TypeScript / Node" });
  });

  it("rejects duplicate skill ids even when their versions differ", async () => {
    const root = await mkdtemp(join(tmpdir(), "dhara-skills-duplicate-"));
    await writeSkill(root, "one", definition);
    await writeSkill(root, "two", { ...definition, version: "2.0.0" });
    await expect(loadStackSkillsFromDirectory(pathToFileURL(`${root}/`))).rejects.toThrow(/duplicate.*typescript-node/i);
  });

  it("identifies an invalid file and schema path without echoing guide contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "dhara-skills-invalid-"));
    const secret = "DO_NOT_ECHO_GUIDE";
    await writeSkill(root, "broken", { ...definition, version: "bad" }, secret);
    try {
      await loadStackSkillsFromDirectory(pathToFileURL(`${root}/`));
      throw new Error("expected load to fail");
    } catch (error) {
      expect(String(error)).toMatch(/broken\/skill\.json/);
      expect(String(error)).toMatch(/version/);
      expect(String(error)).not.toContain(secret);
    }
  });
});
