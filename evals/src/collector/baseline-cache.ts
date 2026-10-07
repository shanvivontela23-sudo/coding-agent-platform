import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BaselineSuiteResult = {
  readonly exitCode: number;
};

export interface BaselineSuiteCache {
  get(key: string): Promise<BaselineSuiteResult | null>;
  set(key: string, value: BaselineSuiteResult): Promise<void>;
}

export function baselineSuiteCacheKey(input: {
  readonly taskId: string;
  readonly pinnedCommit: string;
  readonly regressionCommand: string;
}): string {
  return createHash("sha256")
    .update(input.taskId)
    .update("\0")
    .update(input.pinnedCommit)
    .update("\0")
    .update(input.regressionCommand)
    .digest("hex");
}

export class InMemoryBaselineSuiteCache implements BaselineSuiteCache {
  private readonly values = new Map<string, BaselineSuiteResult>();

  async get(key: string): Promise<BaselineSuiteResult | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: BaselineSuiteResult): Promise<void> {
    this.values.set(key, { ...value });
  }
}

export class FileBaselineSuiteCache implements BaselineSuiteCache {
  constructor(private readonly rootDir: string) {}

  private path(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("baseline cache key must be SHA-256");
    return join(this.rootDir, `${key}.json`);
  }

  async get(key: string): Promise<BaselineSuiteResult | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path(key), "utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("exitCode" in parsed) ||
        typeof (parsed as { exitCode?: unknown }).exitCode !== "number"
      ) {
        throw new Error("invalid baseline cache row");
      }
      return { exitCode: (parsed as { exitCode: number }).exitCode };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async set(key: string, value: BaselineSuiteResult): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.path(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }
}
