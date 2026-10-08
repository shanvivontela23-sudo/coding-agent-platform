import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyseRepositoryArchive } from "../src/repository-analysis.js";

function octal(value: number, width: number): Buffer { return Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii"); }
function archive(entries: readonly { name: string; contents: string }[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.contents);
    const header = Buffer.alloc(512);
    Buffer.from(entry.name).copy(header, 0, 0, 100);
    octal(0o644, 8).copy(header, 100); octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116); octal(data.length, 12).copy(header, 124); octal(0, 12).copy(header, 136);
    Buffer.from("        ").copy(header, 148); Buffer.from("0").copy(header, 156); Buffer.from("ustar\0").copy(header, 257); Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"); Buffer.from(`${checksum}\0 `, "ascii").copy(header, 148);
    parts.push(header, data); const padding = (512 - (data.length % 512)) % 512; if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}

it("detects the customer framework when the main application lives under tools/", async () => {
  const report = await analyseRepositoryArchive(archive([
    { name: "repo/tools/package.json", contents: JSON.stringify({ dependencies: { react: "19.0.0" }, devDependencies: { typescript: "5.9.0" } }) },
    { name: "repo/tools/src/app.tsx", contents: "export const App = () => null;" },
  ]), { maxCompressedBytes: 1024 * 1024, maxUncompressedBytes: 4 * 1024 * 1024, maxFiles: 100, maxFileBytes: 256 * 1024 });
  expect(report.frameworks).toContain("React");
});
