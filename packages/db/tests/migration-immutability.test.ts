import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const directory = "packages/db/migrations";

describe("database migration immutability", () => {
  it("requires every SQL migration to be listed with its exact SHA-256 checksum", async () => {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const manifest = JSON.parse(await readFile(`${directory}/checksums.json`, "utf8")) as Record<string, string>;
    const computed = Object.fromEntries(await Promise.all(files.map(async (file) => {
      const content = await readFile(`${directory}/${file}`);
      return [file, createHash("sha256").update(content).digest("hex")] as const;
    })));

    expect(new Set(files).size).toBe(files.length);
    expect(Object.keys(manifest).sort()).toEqual(files);
    expect(manifest).toEqual(computed);
  });
});
