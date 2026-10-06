import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileHarnessCallStore,
  type HarnessCallRecord,
} from "../src/gateway/http/index.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-http-calls-"));
  tempDirectories.push(directory);
  return { directory, store: new FileHarnessCallStore({ rootDir: directory }) };
}

function call(runId: string, callId: string): HarnessCallRecord {
  return {
    runId,
    callId,
    method: "POST",
    path: "/v1/responses",
    wireApi: "responses",
    provider: "openai",
    model: "primary-model",
    modelSettings: { temperature: 0 },
    paid: true,
    state: "accepted",
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    latencyMs: null,
    litellmCallId: null,
    listPriceCostUsd: null,
    costPending: false,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

describe("FileHarnessCallStore", () => {
  it("lists only the requested run directory and never reads another run", async () => {
    const { directory, store } = await createStore();
    await store.createCall(call("run-a", "call-a"));
    await store.createCall(call("run-b", "call-b"));

    const files = await walk(join(directory, "harness-calls"));
    const runBFile = await (async () => {
      for (const file of files) {
        if ((await readFile(file, "utf8")).includes('"runId":"run-b"')) return file;
      }
      throw new Error("run-b call file missing");
    })();
    await writeFile(runBFile, "must never be parsed while listing run-a\n");

    await expect(store.listCalls("run-a")).resolves.toHaveLength(1);
  });

  it("stores only safe metadata and no prompts, outputs, or credentials", async () => {
    const { directory, store } = await createStore();
    await store.createCall(call("run-a", "call-a"));
    await store.appendRefusal({
      runId: "run-a",
      refusalId: "refusal-a",
      timestampMs: 1_001,
      method: "POST",
      path: "/v1/unknown",
      reason: "unknown-route",
    });

    const serialized = (
      await Promise.all((await walk(directory)).map((path) => readFile(path, "utf8")))
    ).join("\n");
    for (const forbidden of [
      "secret prompt body",
      "secret model output",
      "Bearer client-secret",
      "x-api-key-secret",
      "litellm-upstream-secret",
      "provider-api-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects mutation of immutable call identity", async () => {
    const { store } = await createStore();
    const original = call("run-a", "call-a");
    await store.createCall(original);

    await expect(
      store.saveCall({ ...original, model: "other-model", updatedAtMs: 2_000 }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      store.saveCall({
        ...original,
        state: "completed",
        latencyMs: 100,
        listPriceCostUsd: 0.1,
        updatedAtMs: 2_000,
      }),
    ).resolves.toBeUndefined();
  });
});
