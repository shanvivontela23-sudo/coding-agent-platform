import type { ModelWireApi } from "../types.js";

export type HarnessHttpLimits = {
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
};

export type HarnessRouteSpec = {
  readonly method: "POST";
  readonly path: string;
  readonly wireApi: ModelWireApi;
  readonly enabled: boolean;
  readonly streamingAllowed: boolean;
  readonly paid: boolean;
  readonly modelField: "model";
  readonly forwardRequestHeaders: readonly string[];
  readonly safeResponseHeaders: readonly string[];
  readonly modelSettingFields: readonly string[];
};

export type HarnessRouteEvidence = {
  readonly chatCompletionsTranscriptSha256?: string;
};

export type HarnessHttpConfig = {
  readonly limits: HarnessHttpLimits;
  readonly routes: readonly HarnessRouteSpec[];
  readonly routeEvidence: HarnessRouteEvidence;
};
