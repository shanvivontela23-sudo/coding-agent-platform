import { createHash, randomUUID } from "node:crypto";
import {
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
  CostRecord,
  GatewayRunRecord,
  GatewayStore,
  StoredModelCall,
} from "./types.js";

export type FileGatewayStoreOptions = {
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

async function writeJsonReplacing(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

async function writeJsonOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  try {
    await link(temporaryPath, path);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class FileGatewayStore implements GatewayStore {
  private readonly runsDir: string;
  private readonly callsDir: string;

  constructor(options: FileGatewayStoreOptions) {
    if (!options.rootDir.trim()) throw new Error("gateway store rootDir is required");
    this.runsDir = join(options.rootDir, "runs");
    this.callsDir = join(options.rootDir, "calls");
  }

  async createRun(record: GatewayRunRecord): Promise<void> {
    const created = await writeJsonOnce(this.runPath(record.runId), record);
    if (!created) throw new Error(`run ${record.runId} already exists`);
  }

  async getRun(runId: string): Promise<GatewayRunRecord> {
    const record = await readJson<GatewayRunRecord>(this.runPath(runId));
    if (!record) throw new Error(`run ${runId} not found`);
    return record;
  }

  async saveRun(record: GatewayRunRecord): Promise<void> {
    await writeJsonReplacing(this.runPath(record.runId), record);
  }

  async getStoredCall(
    runId: string,
    idempotencyKey: string,
  ): Promise<StoredModelCall | null> {
    return await readJson<StoredModelCall>(
      this.callPath(runId, idempotencyKey),
    );
  }

  async saveStoredCall(
    runId: string,
    idempotencyKey: string,
    call: StoredModelCall,
  ): Promise<void> {
    const path = this.callPath(runId, idempotencyKey);
    const created = await writeJsonOnce(path, call);
    if (created) return;

    const existing = await readJson<StoredModelCall>(path);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(call)) {
      throw new Error(
        `idempotency key ${idempotencyKey} already has a different response`,
      );
    }
  }

  async listCostRecords(runId: string): Promise<readonly CostRecord[]> {
    const runCallsDir = this.runCallsDir(runId);
    let names: string[];
    try {
      names = await readdir(runCallsDir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const records: CostRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const stored = await readJson<StoredModelCall>(join(runCallsDir, name));
      if (!stored) continue;
      if (stored.costRecord.runId !== runId) {
        throw new Error(`stored call belongs to a different run than ${runId}`);
      }
      records.push(stored.costRecord);
    }
    return records.sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${digest(runId)}.json`);
  }

  private runCallsDir(runId: string): string {
    return join(this.callsDir, digest(runId));
  }

  private callPath(runId: string, idempotencyKey: string): string {
    return join(this.runCallsDir(runId), `${digest(idempotencyKey)}.json`);
  }
}
