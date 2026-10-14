import { readFileSync, readdirSync } from "node:fs";
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

export function loadBuiltInStackSkillsSync(root: URL = new URL("../stacks/", import.meta.url)): ReadonlyMap<string, StackSkill> {
  const registry = new Map<string, StackSkill>();
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = new URL(`${encodeURIComponent(entry.name)}/`, root);
    const jsonUrl = new URL("skill.json", directory);
    const guideUrl = new URL("guide.md", directory);
    let input: unknown;
    try { input = JSON.parse(readFileSync(jsonUrl, "utf8")) as unknown; }
    catch (error) { throw new Error(`Invalid stack skill ${displayPath(jsonUrl)}: ${error instanceof SyntaxError ? "invalid JSON" : "could not be read"}`, { cause: error }); }
    let guide: string;
    try { guide = readFileSync(guideUrl, "utf8"); }
    catch (error) { throw new Error(`Invalid stack skill ${displayPath(guideUrl)}: guide could not be read`, { cause: error }); }
    const skill = parseStackSkillDefinition(input, guide, displayPath(jsonUrl));
    if (registry.has(skill.id)) throw new Error(`Invalid stack skill registry: duplicate skill id ${skill.id}`);
    registry.set(skill.id, skill);
  }
  return registry;
}

// Process entry points call this before opening database pools, listeners or
// worker loops, so a broken built-in skill stops the API or worker at startup
// instead of surfacing mid-task. Errors name the file and schema path only.
export function validateBuiltInStackSkillsAtStartup(processName: string, root?: URL): ReadonlyMap<string, StackSkill> {
  try {
    return loadBuiltInStackSkillsSync(root);
  } catch (error) {
    throw new Error(`${processName} cannot start: ${error instanceof Error ? error.message : "built-in stack skills failed validation"}`, { cause: error });
  }
}
