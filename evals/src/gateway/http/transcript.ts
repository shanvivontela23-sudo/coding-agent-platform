import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ProtocolHarnessIdentity = {
  readonly name: string;
  readonly version: string;
};

export type ProtocolExchange = {
  readonly timestampMs: number;
  readonly method: string;
  readonly path: string;
  readonly headerNames: readonly string[];
  readonly contentType: string | null;
  readonly topLevelFields: readonly string[];
  readonly requestedModel: string | null;
  readonly stream: boolean | null;
  readonly responseStatus: number;
  readonly responseContentType: string | null;
};

export type ProtocolTranscript = {
  readonly schemaVersion: 1;
  readonly harness: ProtocolHarnessIdentity;
  readonly exchanges: readonly ProtocolExchange[];
};

function serializedTranscript(transcript: ProtocolTranscript): string {
  return `${JSON.stringify(transcript, null, 2)}\n`;
}

export function protocolTranscriptSha256(transcript: ProtocolTranscript): string {
  return createHash("sha256").update(serializedTranscript(transcript)).digest("hex");
}

export async function writeProtocolTranscript(
  path: string,
  transcript: ProtocolTranscript,
): Promise<{ readonly path: string; readonly sha256: string }> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, serializedTranscript(transcript), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
  return { path, sha256: protocolTranscriptSha256(transcript) };
}
