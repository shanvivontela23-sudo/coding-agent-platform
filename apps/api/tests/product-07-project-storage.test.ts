import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProjectStorage } from "../src/project-storage.js";

const org = "00000000-0000-4000-8000-000000000001";
const project = "20000000-0000-4000-8000-000000000001";
const version = "30000000-0000-4000-8000-000000000001";

describe("Product 07 local project storage", () => {
  it("stores versions outside the repo with owner-only permissions and supports read/delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "dhara-storage-test-"));
    const storage = new LocalProjectStorage({ rootDir: root });
    const stored = await storage.writeVersion({ organizationId: org, projectId: project, versionId: version, bytes: Buffer.from("normalized-zip") });
    expect(stored.storageKey).toBe(`${org}/${project}/${version}.zip`);
    expect(Buffer.from(await storage.readVersion(stored.storageKey)).toString()).toBe("normalized-zip");
    if (process.platform !== "win32") {
      expect((await stat(join(root, org))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, org, project))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, stored.storageKey))).mode & 0o777).toBe(0o600);
    }
    await storage.deleteProject(org, project);
    await expect(storage.readVersion(stored.storageKey)).rejects.toThrow();
  });

  it("refuses path traversal through storage keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "dhara-storage-test-"));
    const storage = new LocalProjectStorage({ rootDir: root });
    await expect(storage.readVersion("../../outside.zip")).rejects.toThrow(/storage key/i);
  });
});
