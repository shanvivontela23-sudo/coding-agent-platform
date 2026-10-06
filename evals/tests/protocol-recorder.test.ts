import { describe, expect, it, vi } from "vitest";
import {
  ProtocolRecorder,
  protocolTranscriptSha256,
} from "../src/gateway/http/index.js";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function responseText(response: Response): Promise<string> {
  return await response.text();
}

describe("protocol recorder", () => {
  it("records only safe protocol shape and never credential, prompt, tool args, or model output", async () => {
    const forward = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response('{"content":"MODEL_OUTPUT_MUST_NOT_BE_RECORDED"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const recorder = new ProtocolRecorder({
      credential: "RECORDER_SECRET_MUST_NOT_BE_RECORDED",
      harness: { name: "claude-code", version: "1.2.3" },
      forward,
      clock: () => 1234,
    });

    const response = await recorder.handle({
      method: "POST",
      path: "/v1/messages?ignored=yes",
      headers: {
        authorization: "Bearer RECORDER_SECRET_MUST_NOT_BE_RECORDED",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: bytes(
        JSON.stringify({
          model: "claude-primary",
          stream: true,
          messages: [{ role: "user", content: "PROMPT_MUST_NOT_BE_RECORDED" }],
          tools: [{ name: "x", input_schema: { secret: "TOOL_ARGS_MUST_NOT_BE_RECORDED" } }],
        }),
      ),
    });

    expect(await responseText(response)).toContain("MODEL_OUTPUT_MUST_NOT_BE_RECORDED");
    const transcript = recorder.transcript();
    expect(transcript).toEqual({
      schemaVersion: 1,
      harness: { name: "claude-code", version: "1.2.3" },
      exchanges: [
        {
          timestampMs: 1234,
          method: "POST",
          path: "/v1/messages",
          headerNames: ["anthropic-version", "content-type"],
          contentType: "application/json",
          topLevelFields: ["messages", "model", "stream", "tools"],
          requestedModel: "claude-primary",
          stream: true,
          responseStatus: 200,
          responseContentType: "application/json",
        },
      ],
    });
    const serialized = JSON.stringify(transcript);
    for (const forbidden of [
      "RECORDER_SECRET_MUST_NOT_BE_RECORDED",
      "PROMPT_MUST_NOT_BE_RECORDED",
      "TOOL_ARGS_MUST_NOT_BE_RECORDED",
      "MODEL_OUTPUT_MUST_NOT_BE_RECORDED",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(protocolTranscriptSha256(transcript)).toMatch(/^[0-9a-f]{64}$/);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("returns real forwarded responses so a harness can continue into background and token-count traffic", async () => {
    const seenPaths: string[] = [];
    const forward = vi.fn(async (request: Request) => {
      seenPaths.push(new URL(request.url).pathname);
      if (seenPaths.length === 1) {
        return new Response('{"id":"main-ok","content":[{"text":"continue"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response('{"input_tokens":17}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const recorder = new ProtocolRecorder({
      credential: "recorder-only",
      harness: { name: "claude-code", version: "1.2.3" },
      forward,
    });

    const main = await recorder.handle({
      method: "POST",
      path: "/v1/messages",
      headers: { authorization: "Bearer recorder-only", "content-type": "application/json" },
      body: bytes(JSON.stringify({ model: "primary-model", messages: [], stream: false })),
    });
    expect(await responseText(main)).toContain("continue");

    const tokenCount = await recorder.handle({
      method: "POST",
      path: "/v1/messages/count_tokens",
      headers: { authorization: "Bearer recorder-only", "content-type": "application/json" },
      body: bytes(JSON.stringify({ model: "background-model", messages: [] })),
    });
    expect(await responseText(tokenCount)).toContain("input_tokens");

    expect(seenPaths).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    expect(recorder.transcript().exchanges.map((entry) => [entry.path, entry.requestedModel])).toEqual([
      ["/v1/messages", "primary-model"],
      ["/v1/messages/count_tokens", "background-model"],
    ]);
  });

  it("rejects the wrong dedicated recorder credential before forwarding", async () => {
    const forward = vi.fn(async () => new Response("should-not-run"));
    const recorder = new ProtocolRecorder({
      credential: "recorder-only",
      harness: { name: "codex", version: "9.9.9" },
      forward,
    });

    const response = await recorder.handle({
      method: "POST",
      path: "/v1/responses",
      headers: { authorization: "Bearer wrong" },
      body: bytes("{}"),
    });

    expect(response.status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
    expect(recorder.transcript().exchanges).toEqual([]);
  });
});
