import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyseRepositoryArchive } from "../src/repository-analysis.js";

type EntryType = "file" | "pax";
type TarEntry = { readonly name: string; readonly contents?: string | Uint8Array; readonly type?: EntryType };

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.contents === "string" ? Buffer.from(entry.contents) : Buffer.from(entry.contents ?? new Uint8Array());
    const header = Buffer.alloc(512);
    Buffer.from(entry.name).copy(header, 0, 0, 100);
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(data.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    Buffer.from("        ").copy(header, 148);
    Buffer.from(entry.type === "pax" ? "x" : "0").copy(header, 156);
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
    parts.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function archive(entries: readonly TarEntry[]): Uint8Array {
  return gzipSync(tar(entries));
}

function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (true) {
    const record = `${length} ${body}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

const limits = {
  maxCompressedBytes: 2 * 1024 * 1024,
  maxUncompressedBytes: 4 * 1024 * 1024,
  maxFiles: 1_000,
  maxFileBytes: 512 * 1024,
} as const;

type WorkspaceCommand = {
  readonly name: string;
  readonly path: string;
  readonly buildCommand: string | null;
  readonly testCommand: string | null;
};

describe("deterministic project report hardening", () => {
  it("does not infer Python frameworks from the Dhara tooling subtree of a TypeScript repository", async () => {
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/apps/web/package.json", contents: JSON.stringify({ dependencies: { next: "16", react: "19" }, devDependencies: { typescript: "5" } }) },
      { name: "repo/apps/web/app/page.tsx", contents: "export default function Page() { return null; }" },
      { name: "repo/evals/litellm/requirements.txt", contents: "fastapi==0.142.2\nlitellm==1.103.2\n" },
    ]), limits);

    expect(report.frameworks).toContain("Next.js");
    expect(report.frameworks).not.toContain("FastAPI");
  });

  it("requires framework source in the manifest's own subtree rather than anywhere in the repository", async () => {
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/app/package.json", contents: JSON.stringify({ dependencies: { react: "19" }, devDependencies: { typescript: "5" } }) },
      { name: "repo/app/src/index.ts", contents: "export const app = true;" },
      { name: "repo/helpers/cleanup.py", contents: "print('helper')\n" },
      { name: "repo/tooling/requirements.txt", contents: "fastapi==0.142.2\n" },
    ]), limits);

    expect(report.languages.map((language) => language.name)).toEqual(["Python", "TypeScript"]);
    expect(report.frameworks).toContain("React");
    expect(report.frameworks).not.toContain("FastAPI");
  });

  it("reports build and test commands per workspace package when the root has none", async () => {
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/package.json", contents: JSON.stringify({ private: true, workspaces: ["packages/*"] }) },
      { name: "repo/pnpm-workspace.yaml", contents: "packages:\n  - 'packages/*'\n" },
      { name: "repo/pnpm-lock.yaml", contents: "lockfileVersion: '9.0'\n" },
      { name: "repo/packages/api/package.json", contents: JSON.stringify({ name: "@demo/api", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" }, devDependencies: { typescript: "5" } }) },
      { name: "repo/packages/api/src/index.ts", contents: "export const api = true;" },
      { name: "repo/packages/web/package.json", contents: JSON.stringify({ name: "@demo/web", scripts: { build: "next build" }, dependencies: { next: "16", react: "19" }, devDependencies: { typescript: "5" } }) },
      { name: "repo/packages/web/app/page.tsx", contents: "export default function Page() { return null; }" },
    ]), limits);

    expect(report.buildCommand).toBeNull();
    expect(report.testCommand).toBeNull();
    const workspaceCommands = (report as typeof report & { readonly workspaceCommands?: readonly WorkspaceCommand[] }).workspaceCommands;
    expect(workspaceCommands).toEqual([
      { name: "@demo/api", path: "packages/api", buildCommand: "pnpm build", testCommand: "pnpm test" },
      { name: "@demo/web", path: "packages/web", buildCommand: "pnpm build", testCommand: null },
    ]);
  });

  it("detects .NET solutions and projects and emits deterministic dotnet commands while keeping the generic skill", async () => {
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/Demo.sln", contents: "Microsoft Visual Studio Solution File, Format Version 12.00\n" },
      { name: "repo/src/Demo/Demo.csproj", contents: "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>" },
      { name: "repo/src/Demo/Program.cs", contents: "Console.WriteLine(\"hello\");" },
      { name: "repo/tests/Demo.Tests/Demo.Tests.csproj", contents: "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>" },
      { name: "repo/tests/Demo.Tests/SmokeTests.cs", contents: "public class SmokeTests {}" },
    ]), limits);

    expect(report.languages).toEqual([{ name: "C#", fileCount: 2, percentage: 100 }]);
    expect(report.buildCommand).toBe("dotnet build Demo.sln");
    expect(report.testCommand).toBe("dotnet test Demo.sln");
    expect(report.stackSkill).toBe("generic");
    expect(report.manifests).toEqual(expect.arrayContaining(["Demo.sln", "Demo.csproj", "Demo.Tests.csproj"]));
  });

  it("uses a safe PAX path for the following entry so long source paths keep their extension", async () => {
    const longPath = `repo/src/${"deep/".repeat(22)}component.ts`;
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/PaxHeaders/component", type: "pax", contents: paxRecord("path", longPath) },
      { name: "repo/src/placeholder", contents: "export const component = true;" },
      { name: "repo/PaxHeaders/evil", type: "pax", contents: paxRecord("path", "repo/../../outside.py") },
      { name: "repo/src/another-placeholder", contents: "print('must not count')" },
    ]), limits);

    expect(report.languages).toEqual([{ name: "TypeScript", fileCount: 1, percentage: 100 }]);
  });
});
