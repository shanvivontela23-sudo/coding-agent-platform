import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  HarnessCallRecord,
  HarnessCallStore,
  HarnessRefusalRecord,
} from "./store.js";

export type FileHarnessCallStoreOptions = {
  readonly rootDir: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function writeJsonOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeJsonReplacing(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function sanitizeCall(record: HarnessCallRecord): HarnessCallRecord {
  return {
    runId: record.runId,
    callId: record.callId,
    route: record.route,
    wireApi: record.wireApi,
    provider: record.provider,
    model: record.model,
    modelSettings: record.modelSettings,
    paid: record.paid,
    state: record.state,
    usage: {
      inputTokens: record.usage.inputTokens,
      cachedInputTokens: record.usage.cachedInputTokens,
      cacheWriteInputTokens: record.usage.cacheWriteInputTokens,
      outputTokens: record.usage.outputTokens,
      reasoningTokens: record.usage.reasoningTokens,
    },
    latencyMs: record.latencyMs,
    litellmCallId: record.litellmCallId,
    listPriceCostUsd: record.listPriceCostUsd,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

function sanitizeRefusal(record: HarnessRefusalRecord): HarnessRefusalRecord {
  return {
    runId: record.runId,
    timestampMs: record.timestampMs,
    method: record.method,
    path: record.path,
    reason: record.reason,
  };
}

function sameImmutableIdentity(
  left: HarnessCallRecord,
  right: HarnessCallRecord,
): boolean {
  return (
    left.runId === right.runId &&
    left.callId === right.callId &&
    left.route === right.route &&
    left.wireApi === right.wireApi &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.paid === right.paid &&
    JSON.stringify(left.modelSettings) === JSON.stringify(right.modelSettings) &&
    left.createdAtMs === right.createdAtMs
  );
}

export class FileHarnessCallStore implements HarnessCallStore {
  private readonly callsRoot: string;
  private readonly refusalsRoot: string;

  constructor(options: FileHarnessCallStoreOptions) {
    if (!options.rootDir.trim()) throw new Error("harness call store rootDir is required");
    this.callsRoot = join(options.rootDir, "harness-calls");
    this.refusalsRoot = join(options.rootDir, "harness-refusals");
  }

  async createCall(record: HarnessCallRecord): Promise<void> {
    const safe = sanitizeCall(record);
    const created = await writeJsonOnce(this.callPath(safe.runId, safe.callId), safe);
    if (!created) throw new Error(`harness call ${safe.callId} already exists`);
  }

  async saveCall(record: HarnessCallRecord): Promise<void> {
    const safe = sanitizeCall(record);
    const path = this.callPath(safe.runId, safe.callId);
    const existing = await readJson<HarnessCallRecord>(path);
    if (!existing) throw new Error(`harness call ${safe.callId} not found`);
    if (!sameImmutableIdentity(existing, safe)) {
      throw new Error(`immutable harness call identity changed for ${safe.callId}`);
    }
    await writeJsonReplacing(path, safe);
  }

  async getCall(runId: string, callId: string): Promise<HarnessCallRecord> {
    const record = await readJson<HarnessCallRecord>(this.callPath(runId, callId));
    if (!record) throw new Error(`harness call ${callId} not found`);
    if (record.runId !== runId || record.callId !== callId) {
      throw new Error("stored harness call identity mismatch");
    }
    return record;
  }

  async listCalls(runId: string): Promise<readonly HarnessCallRecord[]> {
    const directory = this.runCallsDir(runId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: HarnessCallRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await readJson<HarnessCallRecord>(join(directory, name));
      if (!record) continue;
      if (record.runId !== runId) throw new Error(`stored harness call belongs to another run than ${runId}`);
      records.push(record);
    }
    return records.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  async appendRefusal(record: HarnessRefusalRecord): Promise<void> {
    const safe = sanitizeRefusal(record);
    const directory = this.runRefusalsDir(safe.runId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${safe.timestampMs}-${randomUUID()}.json`);
    const created = await writeJsonOnce(path, safe);
    if (!created) throw new Error("failed to append harness refusal");
  }

  async listRefusals(runId: string): Promise<readonly HarnessRefusalRecord[]> {
    const directory = this.runRefusalsDir(runId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: HarnessRefusalRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await readJson<HarnessRefusalRecord>(join(directory, name));
      if (!record) continue;
      if (record.runId !== runId) throw new Error(`stored refusal belongs to another run than ${runId}`);
      records.push(record);
    }
    return records.sort((a, b) => a.timestampMs - b.timestampMs);
  }

  private runCallsDir(runId: string): string {
    return join(this.callsRoot, digest(runId));
  }

  private runRefusalsDir(runId: string): string {
    return join(this.refusalsRoot, digest(runId));
  }

  private callPath(runId: string, callId: string): string {
    return join(this.runCallsDir(runId), `${digest(callId)}.json`);
  }
}
