import type { HarnessHttpConfig, HarnessRoutePath, HarnessRouteSpec } from "./types.js";

const commonResponseHeaders = ["content-type", "request-id", "x-request-id"] as const;

const routeTemplates: Readonly<Record<HarnessRoutePath, Omit<HarnessRouteSpec, "enabled">>> = {
  "/v1/messages": {
    method: "POST",
    path: "/v1/messages",
    wireApi: "anthropic-messages",
    streamingAllowed: true,
    paid: true,
    modelField: "model",
    forwardedRequestHeaders: [
      "content-type",
      "accept",
      "anthropic-version",
      "anthropic-beta",
    ],
    forwardedResponseHeaders: commonResponseHeaders,
    modelSettingFields: ["max_tokens", "temperature", "top_p", "top_k", "stop_sequences"],
  },
  "/v1/messages/count_tokens": {
    method: "POST",
    path: "/v1/messages/count_tokens",
    wireApi: "anthropic-messages",
    streamingAllowed: false,
    paid: false,
    modelField: "model",
    forwardedRequestHeaders: [
      "content-type",
      "accept",
      "anthropic-version",
      "anthropic-beta",
    ],
    forwardedResponseHeaders: commonResponseHeaders,
    modelSettingFields: [],
  },
  "/v1/responses": {
    method: "POST",
    path: "/v1/responses",
    wireApi: "responses",
    streamingAllowed: true,
    paid: true,
    modelField: "model",
    forwardedRequestHeaders: ["content-type", "accept", "openai-organization", "openai-project"],
    forwardedResponseHeaders: commonResponseHeaders,
    modelSettingFields: [
      "max_output_tokens",
      "temperature",
      "top_p",
      "reasoning",
      "reasoning_effort",
    ],
  },
  "/v1/chat/completions": {
    method: "POST",
    path: "/v1/chat/completions",
    wireApi: "chat-completions",
    streamingAllowed: true,
    paid: true,
    modelField: "model",
    forwardedRequestHeaders: ["content-type", "accept", "openai-organization", "openai-project"],
    forwardedResponseHeaders: commonResponseHeaders,
    modelSettingFields: ["max_tokens", "temperature", "top_p", "reasoning_effort"],
  },
};

export function getHarnessRoute(
  method: string,
  path: string,
  config: HarnessHttpConfig,
): HarnessRouteSpec | null {
  if (method.toUpperCase() !== "POST") return null;
  if (!(path in routeTemplates)) return null;

  const routePath = path as HarnessRoutePath;
  const template = routeTemplates[routePath];
  return {
    ...template,
    enabled: config.enabledRoutes.includes(routePath),
  };
}

export const harnessRoutePaths = Object.freeze(
  Object.keys(routeTemplates) as HarnessRoutePath[],
);
