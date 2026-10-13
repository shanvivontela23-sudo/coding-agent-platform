import { describe, expect, it } from "vitest";
import { LiteLLMAdapter } from "../src/gateway/litellm-adapter.js";

const options = (baseUrl: string) => ({
  baseUrl,
  adminToken: "dummy-admin-token",
});

describe("LiteLLM adapter base URL validation", () => {
  it.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://[::1]:4000",
    "https://litellm.example.com",
  ])("accepts %s", (baseUrl) => {
    expect(() => new LiteLLMAdapter(options(baseUrl))).not.toThrow();
  });

  it.each([
    "http://litellm:4000",
    "http://10.0.0.5:4000",
    "http://127.0.0.1.evil.com",
  ])("rejects insecure non-loopback URL %s", (baseUrl) => {
    expect(() => new LiteLLMAdapter(options(baseUrl))).toThrow(
      "LiteLLM baseUrl must use https outside localhost",
    );
  });
});
