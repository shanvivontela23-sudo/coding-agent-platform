import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function gitBlobSha1(content: Buffer): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

describe("database migration immutability", () => {
  it("never rewrites migration 0001 and only advances with new ordered files", async () => {
    const migration = await readFile("packages/db/migrations/0001_tenant_core.sql");
    expect(gitBlobSha1(migration)).toBe("789ccd2835de3d065dfdaa874e799e5405edac6c");

    const files = (await readdir("packages/db/migrations")).filter((name) => name.endsWith(".sql")).sort();
    expect(files[0]).toBe("0001_tenant_core.sql");
    expect(files).toContain("0002_organization_invitations.sql");
    expect(new Set(files).size).toBe(files.length);
    expect(files).toEqual([...files].sort());
  });
});
