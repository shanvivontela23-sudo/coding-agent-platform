import type { SandboxCommandResult, SandboxProvider, SandboxSession } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "./execution-source.js";
import { testOnlyPatch } from "./patch-parser.js";

export type VerificationCheck = {
  readonly name: "test" | "build";
  readonly command: string;
  readonly baselineExitCode: number;
  readonly patchedExitCode: number;
  readonly status: "passed" | "failed" | "pre_existing" | "pre_existing_unverified" | "skipped";
  readonly baselineFailingTests: readonly string[];
  readonly patchedFailingTests: readonly string[];
};
export type ReproduceClassification = "passed" | "assertion_failure" | "error" | "not_run";
export type ReproduceProof = {
  readonly command: string | null;
  readonly baselineExitCode: number | null;
  readonly patchedExitCode: number | null;
  readonly baselineOutput: string;
  readonly patchedOutput: string;
  readonly baselineClassification: ReproduceClassification;
  readonly patchedClassification: ReproduceClassification;
  readonly reproduced: boolean;
  readonly reason: string | null;
};
export type VerificationResult = { readonly checks: readonly VerificationCheck[]; readonly hasNewFailures: boolean; readonly reproduce: ReproduceProof };
type GeneralRun = { readonly checks: ReadonlyMap<string, SandboxCommandResult> };

function abortError(timedOut = false): Error { return new Error(timedOut ? "verification stage timed out" : "execution aborted"); }
function assertNotAborted(signal: AbortSignal, timedOut = false): void { if (signal.aborted) throw abortError(timedOut); }
function output(result: SandboxCommandResult | null): string { return result ? [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim() : ""; }
function classifyReproduction(result: SandboxCommandResult | null): ReproduceClassification {
  if (!result) return "not_run";
  if (result.exitCode === 0) return "passed";
  const text = output(result);
  if (/no test files? found|not found|cannot find|can't find|no such file|error collecting|collection error|failed to collect|syntaxerror|typeerror:.*compile|ts\d{4}|compilation failed|compile error|module not found|cannot resolve|could not resolve/i.test(text)) return "error";
  return /assertionerror|assertion failed|expected\b.*\b(?:to|but|received)|\bFAIL(?:ED)?\b|[×✗]\s+/i.test(text) ? "assertion_failure" : "error";
}
function failingTestNames(result: SandboxCommandResult): readonly string[] {
  if (result.exitCode === 0) return [];
  const text = output(result);
  const names = new Set<string>();
  for (const pattern of [/(?:^|\n)\s*FAIL\s+([^\n]+)/g, /(?:^|\n)\s*FAILED\s+([^\n]+)/g, /(?:^|\n)\s*[×✗]\s+([^\n]+)/g]) {
    for (const match of text.matchAll(pattern)) { const name = match[1]?.trim(); if (name) names.add(name); }
  }
  return [...names];
}
async function applyPatch(session: SandboxSession, patch: string, timeoutMs: () => number, signal: AbortSignal, timedOut: () => boolean): Promise<void> {
  assertNotAborted(signal, timedOut());
  await session.writeFile(`${session.workspacePath}/.dhara.patch`, patch);
  assertNotAborted(signal, timedOut());
  const applied = await session.exec({ command: "git apply --binary --whitespace=nowarn .dhara.patch", cwd: session.workspacePath, timeoutMs: timeoutMs() });
  assertNotAborted(signal, timedOut());
  if (applied.exitCode !== 0) throw new Error("Exported patch does not apply cleanly to approved source");
}
async function prepareSession(session: SandboxSession, source: PreparedExecutionSource, timeoutMs: () => number, signal: AbortSignal, timedOut: () => boolean): Promise<void> {
  assertNotAborted(signal, timedOut());
  await session.setNetworkPhase("dependency-setup");
  assertNotAborted(signal, timedOut());
  if (source.commands.install) {
    const install = await session.exec({ command: source.commands.install, cwd: session.workspacePath, timeoutMs: timeoutMs() });
    assertNotAborted(signal, timedOut());
    if (install.exitCode !== 0) throw new Error("Verification dependency setup failed");
  }
  await session.setNetworkPhase("offline");
  assertNotAborted(signal, timedOut());
}
async function runGeneralChecks(session: SandboxSession, source: PreparedExecutionSource, timeoutMs: () => number, signal: AbortSignal, timedOut: () => boolean): Promise<GeneralRun> {
  const checks = new Map<string, SandboxCommandResult>();
  if (source.commands.test) { checks.set("test", await session.exec({ command: source.commands.test, cwd: session.workspacePath, timeoutMs: timeoutMs() })); assertNotAborted(signal, timedOut()); }
  if (source.commands.build) { checks.set("build", await session.exec({ command: source.commands.build, cwd: session.workspacePath, timeoutMs: timeoutMs() })); assertNotAborted(signal, timedOut()); }
  return { checks };
}
async function runReproduction(session: SandboxSession, command: string | null, timeoutMs: () => number, signal: AbortSignal, timedOut: () => boolean): Promise<SandboxCommandResult | null> {
  if (!command) return null;
  assertNotAborted(signal, timedOut());
  const result = await session.exec({ command, cwd: session.workspacePath, timeoutMs: timeoutMs() });
  assertNotAborted(signal, timedOut());
  return result;
}
async function withAbortDestroy<T>(session: SandboxSession, signal: AbortSignal, operation: () => Promise<T>, timedOut: () => boolean): Promise<T> {
  let destroyed = false;
  const destroy = async () => { if (!destroyed) { destroyed = true; await session.destroy(); } };
  const onAbort = () => { void destroy(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try { assertNotAborted(signal, timedOut()); return await operation(); }
  finally { signal.removeEventListener("abort", onAbort); await destroy(); }
}

export async function verifyExecution(options: { readonly sandboxProvider: SandboxProvider; readonly taskId: string; readonly source: PreparedExecutionSource; readonly patch: string; readonly reproductionCommand: string | null; readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<VerificationResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("verification timeout must be positive");
  if (options.signal.aborted) throw abortError(false);
  const deadline = Date.now() + options.timeoutMs;
  const stageController = new AbortController();
  let stageTimedOut = false;
  const onOuterAbort = () => stageController.abort();
  options.signal.addEventListener("abort", onOuterAbort, { once: true });
  const stageTimer = setTimeout(() => { stageTimedOut = true; stageController.abort(); }, options.timeoutMs);
  stageTimer.unref?.();
  const signal = stageController.signal;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const timedOut = () => stageTimedOut;
  const testPatch = testOnlyPatch(options.patch);

  try {
    assertNotAborted(signal, timedOut());
    const baseline = await options.sandboxProvider.create({ taskId: `${options.taskId}-baseline`, repository: options.source.repository, gatewayUrl: "http://127.0.0.1:1", timeoutMs: remainingMs() });
    let baselineChecks: GeneralRun | null = null;
    let baselineReproduction: SandboxCommandResult | null = null;
    await withAbortDestroy(baseline, signal, async () => {
      await prepareSession(baseline, options.source, remainingMs, signal, timedOut);
      baselineChecks = await runGeneralChecks(baseline, options.source, remainingMs, signal, timedOut);
      if (testPatch && options.reproductionCommand) {
        await applyPatch(baseline, testPatch, remainingMs, signal, timedOut);
        baselineReproduction = await runReproduction(baseline, options.reproductionCommand, remainingMs, signal, timedOut);
      }
    }, timedOut);

    assertNotAborted(signal, timedOut());
    const patched = await options.sandboxProvider.create({ taskId: `${options.taskId}-patched`, repository: options.source.repository, gatewayUrl: "http://127.0.0.1:1", timeoutMs: remainingMs() });
    let patchedChecks: GeneralRun | null = null;
    let patchedReproduction: SandboxCommandResult | null = null;
    await withAbortDestroy(patched, signal, async () => {
      await prepareSession(patched, options.source, remainingMs, signal, timedOut);
      await applyPatch(patched, options.patch, remainingMs, signal, timedOut);
      patchedChecks = await runGeneralChecks(patched, options.source, remainingMs, signal, timedOut);
      if (testPatch && options.reproductionCommand) patchedReproduction = await runReproduction(patched, options.reproductionCommand, remainingMs, signal, timedOut);
    }, timedOut);

    const baselineRun = baselineChecks as GeneralRun | null;
    const patchedRun = patchedChecks as GeneralRun | null;
    if (!baselineRun || !patchedRun) throw new Error("Verification checks did not complete");
    const checks: VerificationCheck[] = [];
    for (const [name, command] of [["test", options.source.commands.test], ["build", options.source.commands.build]] as const) {
      if (!command) continue;
      const before = baselineRun.checks.get(name);
      const after = patchedRun.checks.get(name);
      if (!before || !after) throw new Error(`Missing ${name} verification result`);
      const beforeNames = failingTestNames(before);
      const afterNames = failingTestNames(after);
      let status: VerificationCheck["status"];
      if (after.exitCode === 0) status = "passed";
      else if (before.exitCode === 0) status = "failed";
      else if (beforeNames.length > 0 && afterNames.length > 0) status = afterNames.some((nameValue) => !beforeNames.includes(nameValue)) ? "failed" : "pre_existing";
      else status = "pre_existing_unverified";
      checks.push({ name, command, baselineExitCode: before.exitCode, patchedExitCode: after.exitCode, status, baselineFailingTests: beforeNames, patchedFailingTests: afterNames });
    }

    const baselineProof = baselineReproduction as SandboxCommandResult | null;
    const patchedProof = patchedReproduction as SandboxCommandResult | null;
    const baselineClassification = classifyReproduction(baselineProof);
    const patchedClassification = classifyReproduction(patchedProof);
    const reproduced = Boolean(testPatch && options.reproductionCommand && baselineClassification === "assertion_failure" && patchedClassification === "passed");
    const reason = reproduced ? null : !testPatch ? "Patch contains no test-file hunks for reproduce-first proof." : !options.reproductionCommand ? "No focused reproduction command could be derived from the added test." : baselineClassification !== "assertion_failure" ? "Baseline did not fail with an assertion failure." : "Patched reproduction test did not pass.";
    return {
      checks,
      hasNewFailures: checks.some((check) => check.status === "failed"),
      reproduce: { command: options.reproductionCommand, baselineExitCode: baselineProof?.exitCode ?? null, patchedExitCode: patchedProof?.exitCode ?? null, baselineOutput: output(baselineProof), patchedOutput: output(patchedProof), baselineClassification, patchedClassification, reproduced, reason },
    };
  } finally {
    clearTimeout(stageTimer);
    options.signal.removeEventListener("abort", onOuterAbort);
  }
}
