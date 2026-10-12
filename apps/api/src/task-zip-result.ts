import { createHash, randomUUID } from "node:crypto";
import type { SessionIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import { applyUnifiedFilePatchBytes } from "./github-publication-client.js";
import { parsePatchFiles } from "../../worker/src/patch-parser.js";
import type { VerifiedFile } from "../../worker/src/verification.js";
import type { ProjectDownloadTokenService } from "./project-download-token.js";
import type { ProjectStorage } from "./project-storage.js";
import { readNormalizedZipFiles, type UploadArchiveLimits } from "./upload-archive.js";

export type TaskZipResultArtifact = {
  readonly executionId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly sourceVersionId: string;
  readonly artifactVersionId: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly promotedVersionId: string | null;
  readonly promotedVersionNumber: number | null;
};
export type TaskZipResultContext = {
  readonly executionId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly status: "succeeded" | "fix_not_reproduced";
  readonly sourceVersionId: string;
  readonly sourceStorageKey: string;
  readonly resultPatch: string;
  readonly changeDocument: string;
  readonly verifiedFiles: readonly VerifiedFile[];
  readonly role: "owner" | "developer" | "rep";
};
export interface TaskZipResultDatabase {
  getContext(session: SessionIdentity, taskId: string): Promise<TaskZipResultContext | null>;
  getArtifact(session: SessionIdentity, executionId: string): Promise<TaskZipResultArtifact | null>;
  saveArtifact(session: SessionIdentity, input: TaskZipResultArtifact): Promise<TaskZipResultArtifact>;
  promote(session: SessionIdentity, artifact: TaskZipResultArtifact): Promise<TaskZipResultArtifact>;
  auditDownload(session: SessionIdentity, artifact: TaskZipResultArtifact): Promise<void>;
}

function mismatch(message: string): never { throw new AppError("PUBLISHED_CONTENT_MISMATCH", message, 409); }
function gitBlobSha(bytes: Uint8Array): string { return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8")).update(bytes).digest("hex"); }
function crc32(input: Uint8Array): number { let crc = 0xffffffff; for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
type ZipEntry = { readonly path: string; readonly bytes: Buffer; readonly unixMode: number };
function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = Buffer.from(entry.path, "utf8"); const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, entry.bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((entry.unixMode << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += local.length + name.length + entry.bytes.length;
  }
  const localBytes = Buffer.concat(locals); const centralBytes = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(localBytes.length, 16); return Buffer.concat([localBytes, centralBytes, eocd]);
}
function verifiedMap(files: readonly VerifiedFile[]): Map<string, VerifiedFile> {
  const map = new Map<string, VerifiedFile>();
  for (const file of files) {
    if (map.has(file.path)) mismatch(`Verified file evidence contains duplicate path ${file.path}.`);
    if (file.deleted) { if (file.blobSha !== null || file.mode !== null) mismatch(`Deleted verified path ${file.path} must not have blob or mode.`); }
    else if (!file.blobSha || !/^[0-9a-f]{40}$/i.test(file.blobSha) || (file.mode !== "100644" && file.mode !== "100755")) mismatch(`Verified file evidence is invalid for ${file.path}.`);
    map.set(file.path, file);
  }
  return map;
}

export async function buildVerifiedZipResult(input: { readonly approvedZip: Uint8Array; readonly patch: string; readonly verifiedFiles: readonly VerifiedFile[]; readonly changeDocument: string; readonly limits: UploadArchiveLimits }): Promise<{ readonly bytes: Uint8Array; readonly sha256: string; readonly sizeBytes: number; readonly fileCount: number }> {
  const parsedFiles = parsePatchFiles(input.patch);
  const verified = verifiedMap(input.verifiedFiles);
  const patchPaths = new Set<string>();
  for (const file of parsedFiles) { if (file.oldPath && (file.newPath === null || file.oldPath !== file.newPath)) patchPaths.add(file.oldPath); if (file.newPath) patchPaths.add(file.newPath); }
  if (patchPaths.size !== verified.size || [...patchPaths].some((path) => !verified.has(path)) || [...verified.keys()].some((path) => !patchPaths.has(path))) mismatch("Verified files do not exactly match patch paths; ZIP result refused.");
  const base = readNormalizedZipFiles(input.approvedZip, input.limits);
  const entries = new Map<string, ZipEntry>(base.map((file) => [file.path, { path: file.path, bytes: Buffer.from(file.bytes), unixMode: 0o100600 }]));
  for (const file of parsedFiles) {
    if (file.oldPath && (file.newPath === null || file.oldPath !== file.newPath)) {
      const evidence = verified.get(file.oldPath); if (!evidence?.deleted) mismatch(`Verified deletion is missing for ${file.oldPath}.`); entries.delete(file.oldPath);
    }
    if (!file.newPath) continue;
    const evidence = verified.get(file.newPath); if (!evidence || evidence.deleted || !evidence.blobSha || !evidence.mode) mismatch(`Verified content is missing for ${file.newPath}.`);
    const source = file.oldPath ? entries.get(file.oldPath)?.bytes : Buffer.alloc(0);
    if (file.oldPath && !source) mismatch(`Approved source file is unavailable: ${file.oldPath}.`);
    let next: Buffer | null = null;
    for (const encoding of ["utf8", "latin1"] as const) {
      try { const candidate = applyUnifiedFilePatchBytes(source ?? Buffer.alloc(0), file.raw, encoding); if (gitBlobSha(candidate) === evidence.blobSha.toLowerCase()) { next = candidate; break; } } catch { /* alternate text encoding */ }
    }
    if (!next) mismatch(`ZIP content would differ from verified content for ${file.newPath}.`);
    entries.set(file.newPath, { path: file.newPath, bytes: next, unixMode: evidence.mode === "100755" ? 0o100755 : 0o100644 });
  }
  const note = input.changeDocument.endsWith("\n") ? input.changeDocument : `${input.changeDocument}\n`;
  entries.set("DHARA_CHANGES.md", { path: "DHARA_CHANGES.md", bytes: Buffer.from(note, "utf8"), unixMode: 0o100644 });
  if (entries.size > input.limits.maxFiles) throw new AppError("UPLOAD_TOO_LARGE", "ZIP result contains too many files.", 413);
  let total = 0; for (const entry of entries.values()) { if (entry.bytes.length > input.limits.maxFileBytes) throw new AppError("UPLOAD_TOO_LARGE", "A ZIP result entry exceeds the per-file limit.", 413); total += entry.bytes.length; }
  if (total > input.limits.maxUncompressedBytes) throw new AppError("UPLOAD_TOO_LARGE", "ZIP result expands beyond the configured limit.", 413);
  const bytes = writeZip([...entries.values()]); if (bytes.byteLength > input.limits.maxCompressedBytes) throw new AppError("UPLOAD_TOO_LARGE", "ZIP result exceeds the configured storage limit.", 413);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, fileCount: entries.size };
}

export function createTaskZipResultService(options: { readonly database: TaskZipResultDatabase; readonly storage: ProjectStorage; readonly downloadTokens: ProjectDownloadTokenService; readonly limits: UploadArchiveLimits }) {
  async function getOrCreate(session: SessionIdentity, taskId: string, acceptUnproven = false): Promise<TaskZipResultArtifact | null> {
    const context = await options.database.getContext(session, taskId); if (!context) return null;
    if (context.status === "fix_not_reproduced" && !acceptUnproven) return await options.database.getArtifact(session, context.executionId);
    const existing = await options.database.getArtifact(session, context.executionId); if (existing) return existing;
    const approvedZip = await options.storage.readVersion(context.sourceStorageKey);
    const built = await buildVerifiedZipResult({ approvedZip, patch: context.resultPatch, verifiedFiles: context.verifiedFiles, changeDocument: context.changeDocument, limits: options.limits });
    const artifactVersionId = randomUUID(); const stored = await options.storage.writeVersion({ organizationId: session.organizationId, projectId: context.projectId, versionId: artifactVersionId, bytes: built.bytes });
    return await options.database.saveArtifact(session, { executionId: context.executionId, taskId: context.taskId, projectId: context.projectId, sourceVersionId: context.sourceVersionId, artifactVersionId, storageKey: stored.storageKey, sha256: built.sha256, sizeBytes: built.sizeBytes, fileCount: built.fileCount, promotedVersionId: null, promotedVersionNumber: null });
  }
  return {
    getOrCreate,
    async acceptUnproven(session: SessionIdentity, taskId: string) { return await getOrCreate(session, taskId, true); },
    async promote(session: SessionIdentity, taskId: string) { const artifact = await getOrCreate(session, taskId, true); if (!artifact) throw new AppError("ZIP_RESULT_UNAVAILABLE", "Updated ZIP is unavailable.", 409); return await options.database.promote(session, artifact); },
    async issueDownloadToken(session: SessionIdentity, taskId: string) { const artifact = await getOrCreate(session, taskId); if (!artifact) throw new AppError("ZIP_RESULT_UNAVAILABLE", "Updated ZIP is unavailable.", 409); return options.downloadTokens.issue({ organizationId: session.organizationId, userId: session.userId, projectId: artifact.projectId, projectVersionId: artifact.artifactVersionId }); },
    async download(session: SessionIdentity, taskId: string, token: string) { let claims; try { claims = options.downloadTokens.verify(token); } catch { throw new AppError("PROJECT_DOWNLOAD_INVALID", "Download link is invalid or expired.", 403); } const artifact = await getOrCreate(session, taskId, true); if (!artifact || claims.organizationId !== session.organizationId || claims.userId !== session.userId || claims.projectId !== artifact.projectId || claims.projectVersionId !== artifact.artifactVersionId) throw new AppError("PROJECT_DOWNLOAD_INVALID", "Download link is invalid or expired.", 403); const bytes = await options.storage.readVersion(artifact.storageKey); await options.database.auditDownload(session, artifact); return { bytes, filename: `${artifact.projectId}-dhara-result.zip` }; },
  };
}
