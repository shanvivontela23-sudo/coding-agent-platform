import type { ModelUsage, ModelWireApi } from "../types.js";
import { normalizeModelUsage } from "../usage.js";
import { SseEventParser, type SseEvent } from "./sse.js";

export type StreamCompletionState =
  | "completed"
  | "timeout"
  | "interrupted"
  | "failed";

export type StreamCompletion = {
  readonly state: StreamCompletionState;
  readonly usage: ModelUsage;
};

export type MeteredStreamOptions = {
  readonly upstream: ReadableStream<Uint8Array>;
  readonly wireApi: ModelWireApi;
  readonly abort: () => void;
  readonly firstResponseTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly signal?: AbortSignal;
};

export type MeteredStream = {
  readonly body: ReadableStream<Uint8Array>;
  readonly completion: Promise<StreamCompletion>;
};

const emptyUsage: ModelUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

class UsageAccumulator {
  private readonly wireApi: ModelWireApi;
  private usageBody: Record<string, unknown> = {};

  constructor(wireApi: ModelWireApi) {
    this.wireApi = wireApi;
  }

  observe(event: SseEvent): void {
    if (!event.data || event.data === "[DONE]") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = asObject(JSON.parse(event.data));
    } catch {
      return;
    }

    if (this.wireApi === "anthropic-messages") {
      const messageUsage = asObject(asObject(parsed.message).usage);
      const eventUsage = asObject(parsed.usage);
      this.usageBody = {
        ...this.usageBody,
        ...messageUsage,
        ...eventUsage,
      };
      return;
    }

    if (this.wireApi === "responses") {
      const responseUsage = asObject(asObject(parsed.response).usage);
      const eventUsage = asObject(parsed.usage);
      if (Object.keys(responseUsage).length > 0) this.usageBody = responseUsage;
      if (Object.keys(eventUsage).length > 0) this.usageBody = eventUsage;
      return;
    }

    const eventUsage = asObject(parsed.usage);
    if (Object.keys(eventUsage).length > 0) this.usageBody = eventUsage;
  }

  result(): ModelUsage {
    if (Object.keys(this.usageBody).length === 0) return emptyUsage;
    return normalizeModelUsage(this.wireApi, { usage: this.usageBody });
  }
}

export function proxyMeteredStream(options: MeteredStreamOptions): MeteredStream {
  const parser = new SseEventParser();
  const usage = new UsageAccumulator(options.wireApi);
  const upstreamReader = options.upstream.getReader();
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let firstChunkSeen = false;
  let settled = false;
  let aborted = false;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion!: (value: StreamCompletion) => void;

  const completion = new Promise<StreamCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  const abortOnce = () => {
    if (aborted) return;
    aborted = true;
    options.abort();
  };

  const clearTimers = () => {
    if (firstTimer) clearTimeout(firstTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
  };

  const finish = (state: StreamCompletionState, streamError?: Error) => {
    if (settled) return;
    settled = true;
    clearTimers();
    if (state !== "completed") abortOnce();
    if (streamError) {
      try {
        outputController?.error(streamError);
      } catch {
        // A cancelled consumer can close the controller before the pump observes it.
      }
    } else if (state === "completed") {
      try {
        outputController?.close();
      } catch {
        // Consumer cancellation already closed the controller.
      }
    }
    resolveCompletion({ state, usage: usage.result() });
  };

  const timeout = (reason: string) => {
    void upstreamReader.cancel(reason).catch(() => undefined);
    finish("timeout", new Error(reason));
  };

  const armFirstResponse = () => {
    firstTimer = setTimeout(
      () => timeout("stream first-response timeout"),
      options.firstResponseTimeoutMs,
    );
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => timeout("stream idle timeout"),
      options.idleTimeoutMs,
    );
  };

  const observeEvents = (events: readonly SseEvent[]) => {
    for (const event of events) usage.observe(event);
  };

  const pump = async () => {
    try {
      while (!settled) {
        const next = await upstreamReader.read();
        if (next.done) {
          observeEvents(parser.finish());
          finish("completed");
          return;
        }
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          if (firstTimer) clearTimeout(firstTimer);
        }
        resetIdle();
        observeEvents(parser.push(next.value));
        outputController?.enqueue(next.value);
      }
    } catch (error) {
      if (settled) return;
      const message = error instanceof Error ? error.message : "stream upstream failure";
      finish("failed", new Error(message));
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
      armFirstResponse();
      maxTimer = setTimeout(
        () => timeout("stream maximum-duration timeout"),
        options.maxDurationMs,
      );
      if (options.signal?.aborted) {
        void upstreamReader.cancel("client interrupted").catch(() => undefined);
        finish("interrupted");
        return;
      }
      options.signal?.addEventListener(
        "abort",
        () => {
          void upstreamReader.cancel("client interrupted").catch(() => undefined);
          finish("interrupted");
        },
        { once: true },
      );
      void pump();
    },
    async cancel() {
      await upstreamReader.cancel("client interrupted").catch(() => undefined);
      finish("interrupted");
    },
  });

  return { body, completion };
}
