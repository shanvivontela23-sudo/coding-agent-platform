import type { ModelUsage, ModelWireApi } from "../types.js";
import type { HarnessRoutePath } from "./types.js";

export type HarnessCallState =
  | "accepted"
  | "streaming"
  | "completed"
  | "rejected"
  | "interrupted"
  | "timeout"
  | "reconciliation-failed";

export type HarnessCallRecord = {
  readonly runId: string;
  readonly callId: string;
  readonly route: HarnessRoutePath;
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
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type HarnessRefusalRecord = {
  readonly runId: string;
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
