import type { ModelUsage, ModelWireApi } from "../types.js";

export type HarnessCallState =
  | "accepted"
  | "streaming"
  | "completed"
  | "timeout"
  | "interrupted"
  | "failed";

export type HarnessCallRecord = {
  readonly runId: string;
  readonly callId: string;
  readonly method: "POST";
  readonly path: string;
  readonly wireApi: ModelWireApi;
  readonly provider: string;
  readonly model: string;
  readonly modelSettings: Readonly<Record<string, unknown>>;
  readonly paid: boolean;
  readonly state: HarnessCallState;
  readonly usage: ModelUsage;
  readonly latencyMs: number | null;
  readonly litellmCallId: string | null;
  readonly listPriceCostUsd: number | null;
  /** True while a paid call still needs authoritative LiteLLM spend reconciliation. */
  readonly costPending: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type HarnessRefusalRecord = {
  readonly runId: string;
  readonly refusalId: string;
  readonly timestampMs: number;
  readonly method: string;
  readonly path: string;
  readonly reason: string;
};

export interface HarnessCallStore {
  createCall(record: HarnessCallRecord): Promise<void>;
  saveCall(record: HarnessCallRecord): Promise<void>;
  getCall(runId: string, callId: string): Promise<HarnessCallRecord>;
  listCalls(runId: string): Promise<readonly HarnessCallRecord[]>;
  appendRefusal(record: HarnessRefusalRecord): Promise<void>;
  listRefusals(runId: string): Promise<readonly HarnessRefusalRecord[]>;
}
