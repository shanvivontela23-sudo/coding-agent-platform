import { describe, expect, it, vi } from "vitest";
import {
  SseEventParser,
  proxyMeteredStream,
} from "../src/gateway/http/index.js";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("SSE parsing", () => {
  it("parses an event when UTF-8, lines, and JSON cross arbitrary chunk boundaries", () => {
    const parser = new SseEventParser();
    const source = bytes(
      'event: response.completed\r\ndata: {"type":"response.completed","note":"ok 🚀"}\r\n\r\n',
    );
    const events = [];

    for (const byte of source) {
      events.push(...parser.push(Uint8Array.of(byte)));
    }

    expect(events).toEqual([
      {
        event: "response.completed",
        data: '{"type":"response.completed","note":"ok 🚀"}',
      },
    ]);
  });
});

describe("metered streaming pass-through", () => {
  it("forwards raw chunks incrementally and extracts OpenAI Responses terminal usage", async () => {
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
      },
    });
    const abort = vi.fn();
    const proxied = proxyMeteredStream({
      upstream,
      wireApi: "responses",
      abort,
      firstResponseTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      maxDurationMs: 5_000,
    });
    const reader = proxied.body.getReader();

    const firstRead = reader.read();
    upstreamController.enqueue(bytes("event: response.output_text.delta\ndata: {\"delta\":\"a\"}\n\n"));
    const first = await firstRead;
    expect(Buffer.from(first.value ?? []).toString("utf8")).toContain("delta");

    const secondRead = reader.read();
    upstreamController.enqueue(
      bytes(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}\n\n',
      ),
    );
    const second = await secondRead;
    expect(Buffer.from(second.value ?? []).toString("utf8")).toContain(
      "response.completed",
    );

    upstreamController.close();
    expect((await reader.read()).done).toBe(true);
    await expect(proxied.completion).resolves.toMatchObject({
      state: "completed",
      usage: {
        inputTokens: 11,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 0,
        outputTokens: 4,
        reasoningTokens: 2,
      },
    });
    expect(abort).not.toHaveBeenCalled();
  });

  it("marks upstream EOF without a provider terminal event as truncated", async () => {
    const raw = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(raw));
        controller.close();
      },
    });
    const abort = vi.fn();
    const proxied = proxyMeteredStream({
      upstream,
      wireApi: "responses",
      abort,
      firstResponseTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      maxDurationMs: 5_000,
    });

    await expect(readAll(proxied.body)).resolves.toBe(raw);
    await expect(proxied.completion).resolves.toMatchObject({ state: "truncated" });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("combines Anthropic start and terminal usage without rewriting SSE bytes", async () => {
    const raw =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens":0}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes(raw)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const proxied = proxyMeteredStream({
      upstream,
      wireApi: "anthropic-messages",
      abort: () => undefined,
      firstResponseTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      maxDurationMs: 5_000,
    });

    await expect(readAll(proxied.body)).resolves.toBe(raw);
    await expect(proxied.completion).resolves.toMatchObject({
      state: "completed",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 5,
      },
    });
  });

  it("aborts and reports timeout when the stream is idle", async () => {
    vi.useFakeTimers();
    try {
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("event: ping\ndata: {}\n\n"));
        },
      });
      const abort = vi.fn();
      const proxied = proxyMeteredStream({
        upstream,
        wireApi: "responses",
        abort,
        firstResponseTimeoutMs: 50,
        idleTimeoutMs: 10,
        maxDurationMs: 100,
      });
      const reader = proxied.body.getReader();
      await reader.read();

      await vi.advanceTimersByTimeAsync(11);
      await expect(proxied.completion).resolves.toMatchObject({ state: "timeout" });
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks client cancellation interrupted and aborts upstream", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("event: ping\ndata: {}\n\n"));
      },
    });
    const abort = vi.fn();
    const proxied = proxyMeteredStream({
      upstream,
      wireApi: "responses",
      abort,
      firstResponseTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      maxDurationMs: 5_000,
    });
    const reader = proxied.body.getReader();
    await reader.read();
    await reader.cancel();

    await expect(proxied.completion).resolves.toMatchObject({
      state: "interrupted",
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
