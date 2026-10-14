import { readFile, readdir } from "node:fs/promises";
import { parseStackSkillDefinition, type StackSkill } from "./schema.js";

function displayPath(url: URL): string {
  const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  return segments.slice(-3).join("/");
}

async function loadOne(directory: URL): Promise<StackSkill> {
  const jsonUrl = new URL("skill.json", directory);
  const guideUrl = new URL("guide.md", directory);
  let input: unknown;
  try {
    input = JSON.parse(await readFile(jsonUrl, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof SyntaxError ? "invalid JSON" : "could not be read";
    throw new Error(`Invalid stack skill ${displayPath(jsonUrl)}: ${message}`, { cause: error });
  }
  let guide: string;
  try { guide = await readFile(guideUrl, "utf8"); }
  catch (error) { throw new Error(`Invalid stack skill ${displayPath(guideUrl)}: guide could not be read`, { cause: error }); }
  return parseStackSkillDefinition(input, guide, displayPath(jsonUrl));
}

export async function loadStackSkillsFromDirectory(root: URL): Promise<ReadonlyMap<string, StackSkill>> {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const registry = new Map<string, StackSkill>();
  const versions = new Set<string>();
  for (const entry of entries) {
    const skill = await loadOne(new URL(`${encodeURIComponent(entry.name)}/`, root));
    if (registry.has(skill.id)) throw new Error(`Invalid stack skill registry: duplicate skill id ${skill.id}`);
    const identity = `${skill.id}@${skill.version}`;
    if (versions.has(identity)) throw new Error(`Invalid stack skill registry: duplicate skill version ${identity}`);
    versions.add(identity);
    registry.set(skill.id, skill);
  }
  return registry;
}

export async function loadBuiltInStackSkills(): Promise<ReadonlyMap<string, StackSkill>> {
  return await loadStackSkillsFromDirectory(new URL("../stacks/", import.meta.url));
}
