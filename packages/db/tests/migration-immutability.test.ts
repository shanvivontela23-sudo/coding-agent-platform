import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function gitBlobSha1(content: Buffer): string { const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8"); return createHash("sha1").update(header).update(content).digest("hex"); }

type Manifest = { readonly algorithm: "git-blob-sha1"; readonly files: Readonly<Record<string, string>> };

describe("database migration immutability", () => {
  it("requires every migration to match the checksum manifest and rejects unlisted files", async () => {
    const manifest = JSON.parse(await readFile("packages/db/migrations/checksums.json", "utf8")) as Manifest;
    expect(manifest.algorithm).toBe("git-blob-sha1");
    const files = (await readdir("packages/db/migrations")).filter((name) => name.endsWith(".sql")).sort();
    expect(Object.keys(manifest.files).sort()).toEqual(files);
    for (const file of files) expect(gitBlobSha1(await readFile(`packages/db/migrations/${file}`)), file).toBe(manifest.files[file]);
    expect(files).toContain("0003_github_projects.sql");
  });
});
