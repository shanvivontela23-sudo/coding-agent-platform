import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadStoreModule() {
  const path = "../src/gateway/http/file-store.js";
  return await import(path).catch(() => ({} as Record<string, unknown>));
}

function usage() {
  return {
    inputTokens: 10,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    outputTokens: 3,
    reasoningTokens: 1,
  };
}

function call(runId: string, callId: string) {
  return {
    runId,
    callId,
    route: "/v1/responses",
    wireApi: "responses",
    provider: "openai",
    model: "primary-model",
    modelSettings: { reasoning_effort: "high" },
    paid: true,
    state: "accepted",
    usage: usage(),
    latencyMs: null,
    litellmCallId: callId,
    listPriceCostUsd: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

async function walk(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else result.push(path);
  }
  return result;
}

describe("P0-05 harness call store", () => {
  it("isolates calls by run directory and never parses another run", async () => {
    const module = await loadStoreModule();
    expect(typeof module.FileHarnessCallStore).toBe("function");
    const root = await mkdtemp(join(tmpdir(), "harness-call-store-"));
    roots.push(root);
    const Store = module.FileHarnessCallStore as new (options: { rootDir: string }) => {
      createCall(value: unknown): Promise<void>;
      listCalls(runId: string): Promise<unknown[]>;
    };
    const store = new Store({ rootDir: root });
    await store.createCall(call("run-a", "call-a"));
    await store.createCall(call("run-b", "call-b"));

    const files = await walk(join(root, "harness-calls"));
    const runBFile = files.find(async () => false) ?? files.find((path) => path.endsWith(".json"));
    // Identify the run-b file by its contents, then corrupt it.
    let corruptPath = "";
    for (const path of files) {
      if ((await readFile(path, "utf8")).includes('"runId":"run-b"')) corruptPath = path;
    }
    expect(corruptPath || runBFile).toBeTruthy();
    await writeFile(corruptPath, "this file must never be parsed for run-a\n");

    await expect(store.listCalls("run-a")).resolves.toHaveLength(1);
  });

  it("stores no prompt, output, or credential material", async () => {
    const module = await loadStoreModule();
    expect(typeof module.FileHarnessCallStore).toBe("function");
    const root = await mkdtemp(join(tmpdir(), "harness-call-store-"));
    roots.push(root);
    const Store = module.FileHarnessCallStore as new (options: { rootDir: string }) => {
      createCall(value: unknown): Promise<void>;
      appendRefusal(value: unknown): Promise<void>;
    };
    const store = new Store({ rootDir: root });
    await store.createCall(call("run-a", "call-a"));
    await store.appendRefusal({
      runId: "run-a",
      timestampMs: 1_001,
      method: "POST",
      path: "/v1/unknown",
      reason: "unknown-route",
    });

    const serialized = (await Promise.all((await walk(root)).map((path) => readFile(path, "utf8")))).join("\n");
    expect(serialized).not.toContain("super-secret-provider-key");
    expect(serialized).not.toContain("Fix the hidden customer bug");
    expect(serialized).not.toContain("private model output");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("x-api-key");
  });

  it("rejects mutation of immutable call identity", async () => {
    const module = await loadStoreModule();
    expect(typeof module.FileHarnessCallStore).toBe("function");
    const root = await mkdtemp(join(tmpdir(), "harness-call-store-"));
    roots.push(root);
    const Store = module.FileHarnessCallStore as new (options: { rootDir: string }) => {
      createCall(value: unknown): Promise<void>;
      saveCall(value: unknown): Promise<void>;
    };
    const store = new Store({ rootDir: root });
    const original = call("run-a", "call-a");
    await store.createCall(original);

    await expect(
      store.saveCall({ ...original, model: "different-model", state: "completed" }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      store.saveCall({ ...original, state: "completed", updatedAtMs: 2_000 }),
    ).resolves.toBeUndefined();
  });
});
