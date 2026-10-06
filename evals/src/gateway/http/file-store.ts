import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeReplacing(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function writeOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporaryPath, path);
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function sameIdentity(
  left: HarnessCallRecord,
  right: HarnessCallRecord,
): boolean {
  return (
    left.runId === right.runId &&
    left.callId === right.callId &&
    left.method === right.method &&
    left.path === right.path &&
    left.wireApi === right.wireApi &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.paid === right.paid
  );
}

export class FileHarnessCallStore implements HarnessCallStore {
  private readonly callsRoot: string;
  private readonly refusalsRoot: string;

  constructor(options: FileHarnessCallStoreOptions) {
    if (!options.rootDir.trim()) {
      throw new Error("harness call store rootDir is required");
    }
    this.callsRoot = join(options.rootDir, "harness-calls");
    this.refusalsRoot = join(options.rootDir, "harness-refusals");
  }

  async createCall(record: HarnessCallRecord): Promise<void> {
    const created = await writeOnce(this.callPath(record.runId, record.callId), record);
    if (!created) throw new Error(`harness call ${record.callId} already exists`);
  }

  async saveCall(record: HarnessCallRecord): Promise<void> {
    const path = this.callPath(record.runId, record.callId);
    const existing = await readJson<HarnessCallRecord>(path);
    if (!existing) throw new Error(`harness call ${record.callId} not found`);
    if (!sameIdentity(existing, record)) {
      throw new Error("immutable harness call identity cannot be changed");
    }
    await writeReplacing(path, record);
  }

  async getCall(runId: string, callId: string): Promise<HarnessCallRecord> {
    const record = await readJson<HarnessCallRecord>(this.callPath(runId, callId));
    if (!record) throw new Error(`harness call ${callId} not found`);
    if (record.runId !== runId || record.callId !== callId) {
      throw new Error("stored harness call identity does not match requested call");
    }
    return record;
  }

  async listCalls(runId: string): Promise<readonly HarnessCallRecord[]> {
    return await this.listRunRecords<HarnessCallRecord>(
      this.runCallsDir(runId),
      (record) => {
        if (record.runId !== runId) {
          throw new Error(`stored harness call belongs to a different run than ${runId}`);
        }
      },
    );
  }

  async appendRefusal(record: HarnessRefusalRecord): Promise<void> {
    const created = await writeOnce(
      this.refusalPath(record.runId, record.refusalId),
      record,
    );
    if (!created) throw new Error(`refusal ${record.refusalId} already exists`);
  }

  async listRefusals(runId: string): Promise<readonly HarnessRefusalRecord[]> {
    return await this.listRunRecords<HarnessRefusalRecord>(
      this.runRefusalsDir(runId),
      (record) => {
        if (record.runId !== runId) {
          throw new Error(`stored refusal belongs to a different run than ${runId}`);
        }
      },
    );
  }

  private async listRunRecords<T>(
    directory: string,
    validate: (record: T) => void,
  ): Promise<readonly T[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const records: T[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await readJson<T>(join(directory, name));
      if (!record) continue;
      validate(record);
      records.push(record);
    }
    return records;
  }

  private runCallsDir(runId: string): string {
    return join(this.callsRoot, digest(runId));
  }

  private callPath(runId: string, callId: string): string {
    return join(this.runCallsDir(runId), `${digest(callId)}.json`);
  }

  private runRefusalsDir(runId: string): string {
    return join(this.refusalsRoot, digest(runId));
  }

  private refusalPath(runId: string, refusalId: string): string {
    return join(this.runRefusalsDir(runId), `${digest(refusalId)}.json`);
  }
}
