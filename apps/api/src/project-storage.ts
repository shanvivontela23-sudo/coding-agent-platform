import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ProjectStorage {
  writeVersion(input: { readonly organizationId: string; readonly projectId: string; readonly versionId: string; readonly bytes: Uint8Array }): Promise<{ readonly storageKey: string }>;
  readVersion(storageKey: string): Promise<Uint8Array>;
  deleteProject(organizationId: string, projectId: string): Promise<void>;
}

const segment = /^[0-9a-zA-Z][0-9a-zA-Z._-]*$/;
function safeSegment(value: string, label: string): string {
  if (!segment.test(value) || value === "." || value === "..") throw new Error(`${label} is invalid`);
  return value;
}
function storageKeyPath(root: string, key: string): string {
  const normalized = key.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.length !== 3 || parts.some((part) => !segment.test(part) || part === "." || part === "..") || !parts[2]?.endsWith(".zip")) throw new Error("storage key is invalid");
  const target = resolve(root, ...parts); const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("storage key is invalid");
  return target;
}

export class LocalProjectStorage implements ProjectStorage {
  private readonly rootDir: string;
  constructor(options: { readonly rootDir: string }) {
    if (!options.rootDir.trim()) throw new Error("project storage root is required");
    this.rootDir = resolve(options.rootDir);
  }

  async writeVersion(input: { readonly organizationId: string; readonly projectId: string; readonly versionId: string; readonly bytes: Uint8Array }): Promise<{ readonly storageKey: string }> {
    const organizationId = safeSegment(input.organizationId, "organizationId"); const projectId = safeSegment(input.projectId, "projectId"); const versionId = safeSegment(input.versionId, "versionId");
    const storageKey = `${organizationId}/${projectId}/${versionId}.zip`; const target = storageKeyPath(this.rootDir, storageKey); const directory = dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700).catch(() => undefined);
    await chmod(join(this.rootDir, organizationId), 0o700);
    await chmod(directory, 0o700);
    await writeFile(target, input.bytes, { mode: 0o600 }); await chmod(target, 0o600);
    return { storageKey };
  }

  async readVersion(storageKey: string): Promise<Uint8Array> { return await readFile(storageKeyPath(this.rootDir, storageKey)); }

  async deleteProject(organizationIdValue: string, projectIdValue: string): Promise<void> {
    const organizationId = safeSegment(organizationIdValue, "organizationId"); const projectId = safeSegment(projectIdValue, "projectId");
    const target = resolve(this.rootDir, organizationId, projectId); const rel = relative(this.rootDir, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("project storage path is invalid");
    await rm(target, { recursive: true, force: true });
  }
}
