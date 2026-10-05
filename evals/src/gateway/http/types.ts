import type { ModelWireApi } from "../types.js";

export type HarnessRoutePath =
  | "/v1/messages"
  | "/v1/messages/count_tokens"
  | "/v1/responses"
  | "/v1/chat/completions";

export type HarnessHttpConfig = {
  readonly schemaVersion: 1;
  readonly maxBodyBytes: number;
  readonly ratePerMinute: number;
  readonly rateBurst: number;
  readonly nonStreamingTimeoutMs: number;
  readonly firstResponseTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly maxStreamDurationMs: number;
  readonly reconciliationTimeoutMs: number;
  readonly reconciliationInitialDelayMs: number;
  readonly reconciliationMaxDelayMs: number;
  readonly costToleranceUsd: number;
  readonly enabledRoutes: readonly HarnessRoutePath[];
  readonly routeEvidence: {
    readonly chatCompletionsTranscriptSha256?: string;
  };
};

export type HarnessRouteSpec = {
  readonly method: "POST";
  readonly path: HarnessRoutePath;
  readonly wireApi: ModelWireApi;
  readonly enabled: boolean;
  readonly streamingAllowed: boolean;
  readonly paid: boolean;
  readonly modelField: "model";
  readonly forwardedRequestHeaders: readonly string[];
  readonly forwardedResponseHeaders: readonly string[];
  readonly modelSettingFields: readonly string[];
};
