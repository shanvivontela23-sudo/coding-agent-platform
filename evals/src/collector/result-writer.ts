import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runResultSchema, type RunResult } from "../domain/run-result.js";

export interface RunResultWriter {
  write(result: RunResult): Promise<void>;
}

export class FileRunResultWriter implements RunResultWriter {
  constructor(private readonly rootDir: string) {}

  async write(result: RunResult): Promise<void> {
    const validated = runResultSchema.parse(result);
    await mkdir(this.rootDir, { recursive: true });
    const fileName = `${createHash("sha256").update(validated.runId).digest("hex")}.json`;
    const target = join(this.rootDir, fileName);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
  }
}
