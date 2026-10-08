import { createHash } from "node:crypto";
import { gzipSync, inflateRawSync } from "node:zlib";
import { AppError } from "./errors.js";
import { analyseRepositoryArchive, type ProjectReport, type RepositoryAnalysisLimits } from "./repository-analysis.js";

export type UploadArchiveLimits = RepositoryAnalysisLimits & { readonly maxNestedArchiveDepth: number };
export type ValidatedUploadArchive = {
  readonly normalizedZip: Uint8Array;
  readonly report: ProjectReport;
  readonly fileCount: number;
  readonly paths: readonly string[];
  readonly sha256: string;
  readonly sizeBytes: number;
};
type Entry = { readonly path: string; readonly bytes: Buffer };

const eocdSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const archivePattern = /\.(?:zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|7z|rar)$/i;

function invalid(message: string): AppError { return new AppError("INVALID_UPLOAD_ARCHIVE", message, 400); }
function tooLarge(message: string): AppError { return new AppError("UPLOAD_TOO_LARGE", message, 413); }
function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function safePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw invalid("Archive contains an unsafe path.");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.includes("..") || segments.includes(".")) throw invalid("Archive contains an unsafe path.");
  return segments.join("/");
}
function findEocd(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) if (bytes.readUInt32LE(offset) === eocdSignature) return offset;
  throw invalid("ZIP end-of-directory record is missing.");
}
function decodeZipEntries(input: Uint8Array, limits: Pick<UploadArchiveLimits, "maxCompressedBytes" | "maxUncompressedBytes" | "maxFiles" | "maxFileBytes">): Entry[] {
  const bytes = Buffer.from(input);
  if (bytes.length > limits.maxCompressedBytes) throw tooLarge("Compressed ZIP exceeds the configured upload limit.");
  const eocd = findEocd(bytes);
  const disk = bytes.readUInt16LE(eocd + 4); const centralDisk = bytes.readUInt16LE(eocd + 6);
  const count = bytes.readUInt16LE(eocd + 10); const centralSize = bytes.readUInt32LE(eocd + 12); const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw invalid("Multi-disk and ZIP64 uploads are not supported.");
  if (count > limits.maxFiles) throw tooLarge("ZIP contains too many files.");
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw invalid("ZIP central directory is invalid.");
  const entries: Entry[] = []; let offset = centralOffset; let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== centralSignature) throw invalid("ZIP central directory entry is invalid.");
    const versionMadeBy = bytes.readUInt16LE(offset + 4); const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16); const compressedSize = bytes.readUInt32LE(offset + 20); const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const commentLength = bytes.readUInt16LE(offset + 32); const external = bytes.readUInt32LE(offset + 38); const localOffset = bytes.readUInt32LE(offset + 42);
    if ((flags & 1) !== 0) throw invalid("Encrypted ZIP entries are not supported.");
    if (method !== 0 && method !== 8) throw invalid("ZIP compression method is not supported.");
    if (uncompressedSize > limits.maxFileBytes) throw tooLarge("A ZIP entry exceeds the per-file limit.");
    total += uncompressedSize; if (total > limits.maxUncompressedBytes) throw tooLarge("ZIP expands beyond the configured limit.");
    const nameStart = offset + 46; const nameEnd = nameStart + nameLength; if (nameEnd + extraLength + commentLength > bytes.length) throw invalid("ZIP entry metadata is truncated.");
    const rawName = bytes.subarray(nameStart, nameEnd).toString("utf8"); const path = safePath(rawName.replace(/\/$/, ""));
    const creator = versionMadeBy >>> 8; const mode = creator === 3 ? (external >>> 16) & 0xffff : 0; const type = mode & 0o170000; const isDirectory = rawName.endsWith("/") || type === 0o040000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw invalid("ZIP contains a symlink, device, or other special entry.");
    if (!isDirectory) {
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== localSignature) throw invalid("ZIP local entry is invalid.");
      const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtraLength = bytes.readUInt16LE(localOffset + 28); const dataStart = localOffset + 30 + localNameLength + localExtraLength; const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) throw invalid("ZIP entry data is truncated.");
      const compressed = bytes.subarray(dataStart, dataEnd); let decoded: Buffer;
      try { decoded = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes + 1 }); } catch { throw invalid("ZIP entry could not be decompressed safely."); }
      if (decoded.length !== uncompressedSize || decoded.length > limits.maxFileBytes) throw invalid("ZIP entry size does not match its metadata.");
      if (crc32(decoded) !== expectedCrc) throw invalid("ZIP entry checksum is invalid.");
      entries.push({ path, bytes: decoded });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (entries.length > limits.maxFiles) throw tooLarge("ZIP contains too many files.");
  return entries;
}
function stripOneRoot(entries: readonly Entry[]): Entry[] {
  if (entries.length === 0) throw invalid("ZIP does not contain files.");
  const split = entries.map((entry) => entry.path.split("/")); const root = split[0]?.[0];
  const strip = Boolean(root) && split.every((segments) => segments.length > 1 && segments[0] === root);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const path = strip ? split[index]!.slice(1).join("/") : entry.path;
    if (!path || seen.has(path)) throw invalid("ZIP contains duplicate normalized paths.");
    seen.add(path); return { path, bytes: entry.bytes };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function inspectNestedArchives(entries: readonly Entry[], limits: UploadArchiveLimits): void {
  for (const entry of entries) {
    if (!archivePattern.test(entry.path) || !entry.path.toLowerCase().endsWith(".zip")) continue;
    if (limits.maxNestedArchiveDepth < 1) throw invalid("Nested archives are not allowed.");
    const nested = decodeZipEntries(entry.bytes, limits);
    if (nested.some((item) => archivePattern.test(item.path))) throw invalid("Archive nesting exceeds the configured depth.");
  }
}
function tarOctal(value: number, width: number): Buffer { return Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii"); }
function toAnalysisArchive(entries: readonly Entry[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.path) > 99) continue;
    const header = Buffer.alloc(512); Buffer.from(entry.path).copy(header, 0); tarOctal(0o600, 8).copy(header, 100); tarOctal(0, 8).copy(header, 108); tarOctal(0, 8).copy(header, 116); tarOctal(entry.bytes.length, 12).copy(header, 124); tarOctal(0, 12).copy(header, 136); Buffer.from("        ").copy(header, 148); Buffer.from("0").copy(header, 156); Buffer.from("ustar\0").copy(header, 257); Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"); Buffer.from(`${checksum}\0 `).copy(header, 148); parts.push(header, entry.bytes); const padding = (512 - (entry.bytes.length % 512)) % 512; if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}
function writeZip(entries: readonly Entry[]): Uint8Array {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path); const crc = crc32(entry.bytes); const local = Buffer.alloc(30); local.writeUInt32LE(localSignature, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, entry.bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(centralSignature, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100600 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += local.length + name.length + entry.bytes.length;
  }
  const localBytes = Buffer.concat(locals); const centralBytes = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(eocdSignature, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(localBytes.length, 16); return Buffer.concat([localBytes, centralBytes, eocd]);
}

export function readNormalizedZipFiles(input: Uint8Array, limits: UploadArchiveLimits): ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }> {
  return stripOneRoot(decodeZipEntries(input, limits));
}

export async function validateAndNormalizeZip(input: Uint8Array, limits: UploadArchiveLimits): Promise<ValidatedUploadArchive> {
  const entries = stripOneRoot(decodeZipEntries(input, limits)); inspectNestedArchives(entries, limits);
  const normalizedZip = writeZip(entries); const sha256 = createHash("sha256").update(normalizedZip).digest("hex");
  const report = await analyseRepositoryArchive(toAnalysisArchive(entries), limits);
  return { normalizedZip, report, fileCount: entries.length, paths: entries.map((entry) => entry.path), sha256, sizeBytes: normalizedZip.length };
}
