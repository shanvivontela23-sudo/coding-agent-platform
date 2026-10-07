import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type ChecksumManifest = Readonly<Record<string, string>>;

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("database migration immutability", () => {
  it("requires every migration to be listed in the checksum manifest and unchanged", async () => {
    const directory = "packages/db/migrations";
    const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    const manifest = JSON.parse(await readFile(`${directory}/checksums.json`, "utf8")) as ChecksumManifest;

    expect(Object.keys(manifest).sort()).toEqual(files);
    for (const file of files) {
      const expected = manifest[file];
      expect(expected, `${file} must be listed`).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(await readFile(`${directory}/${file}`)), `${file} checksum`).toBe(expected);
    }
  });
});