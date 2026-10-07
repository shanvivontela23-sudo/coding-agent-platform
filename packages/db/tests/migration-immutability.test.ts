import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const directory = "packages/db/migrations";

describe("database migration immutability", () => {
  it("requires every SQL migration to be listed with its exact SHA-256 checksum", async () => {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const manifest = JSON.parse(await readFile(`${directory}/checksums.json`, "utf8")) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(files);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toEqual([...files].sort());

    for (const file of files) {
      const content = await readFile(`${directory}/${file}`);
      const digest = createHash("sha256").update(content).digest("hex");
      expect(manifest[file], `${file} checksum`).toBe(digest);
    }
  });
});
