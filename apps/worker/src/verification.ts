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

export type VerificationResult = {
  readonly checks: readonly VerificationCheck[];
  readonly hasNewFailures: boolean;
  readonly reproduce: ReproduceProof;
};

type GeneralRun = { readonly checks: ReadonlyMap<string, SandboxCommandResult> };

function abortError(): Error { return new Error("execution aborted"); }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
function output(result: SandboxCommandResult | null): string { return result ? [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim() : ""; }

function classifyReproduction(result: SandboxCommandResult | null): ReproduceClassification {
  if (!result) return "not_run";
  if (result.exitCode === 0) return "passed";
  const text = output(result);
  const infrastructureError = /no test files? found|not found|cannot find|can't find|no such file|error collecting|collection error|failed to collect|syntaxerror|typeerror:.*compile|ts\d{4}|compilation failed|compile error|module not found|cannot resolve|could not resolve/i;
  if (infrastructureError.test(text)) return "error";
  const assertionFailure = /assertionerror|assertion failed|expected\b.*\b(?:to|but|received)|\bFAIL(?:ED)?\b|[×✗]\s+/i;
  return assertionFailure.test(text) ? "assertion_failure" : "error";
}

function failingTestNames(result: SandboxCommandResult): readonly string[] {
  if (result.exitCode === 0) return [];
  const text = output(result);
  const names = new Set<string>();
  for (const pattern of [/(?:^|\n)\s*FAIL\s+([^\n]+)/g, /(?:^|\n)\s*FAILED\s+([^\n]+)/g, /(?:^|\n)\s*[×✗]\s+([^\n]+)/g]) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

async function applyPatch(session: SandboxSession, patch: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  const patchPath = `${session.workspacePath}/.dhara.patch`;
  await session.writeFile(patchPath, patch);
  assertNotAborted(signal);
  const applied = await session.exec({ command: "git apply --binary --whitespace=nowarn .dhara.patch", cwd: session.workspacePath, timeoutMs });
  assertNotAborted(signal);
  if (applied.exitCode !== 0) throw new Error("Exported patch does not apply cleanly to approved source");
}

async function prepareSession(session: SandboxSession, source: PreparedExecutionSource, timeoutMs: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  await session.setNetworkPhase("dependency-setup");
  assertNotAborted(signal);
  if (source.commands.install) {
    const install = await session.exec({ command: source.commands.install, cwd: session.workspacePath, timeoutMs });
    assertNotAborted(signal);
    if (install.exitCode !== 0) throw new Error("Verification dependency setup failed");
  }
  await session.setNetworkPhase("offline");
  assertNotAborted(signal);
}

async function runGeneralChecks(session: SandboxSession, source: PreparedExecutionSource, timeoutMs: number, signal: AbortSignal): Promise<GeneralRun> {
  const checks = new Map<string, SandboxCommandResult>();
  if (source.commands.test) {
    checks.set("test", await session.exec({ command: source.commands.test, cwd: session.workspacePath, timeoutMs }));
    assertNotAborted(signal);
  }
  if (source.commands.build) {
    checks.set("build", await session.exec({ command: source.commands.build, cwd: session.workspacePath, timeoutMs }));
    assertNotAborted(signal);
  }
  return { checks };
}

async function runReproduction(session: SandboxSession, command: string | null, timeoutMs: number, signal: AbortSignal): Promise<SandboxCommandResult | null> {
  if (!command) return null;
  assertNotAborted(signal);
  const result = await session.exec({ command, cwd: session.workspacePath, timeoutMs });
  assertNotAborted(signal);
  return result;
}

async function withAbortDestroy<T>(session: SandboxSession, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  let destroyed = false;
  const destroy = async () => { if (!destroyed) { destroyed = true; await session.destroy(); } };
  const onAbort = () => { void destroy(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertNotAborted(signal);
    return await operation();
  } finally {
    signal.removeEventListener("abort", onAbort);
    await destroy();
  }
}

export async function verifyExecution(options: {
  readonly sandboxProvider: SandboxProvider;
  readonly taskId: string;
  readonly source: PreparedExecutionSource;
  readonly patch: string;
  readonly reproductionCommand: string | null;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<VerificationResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("verification timeout must be positive");
  assertNotAborted(options.signal);
  const testPatch = testOnlyPatch(options.patch);

  const baseline = await options.sandboxProvider.create({ taskId: `${options.taskId}-baseline`, repository: options.source.repository, gatewayUrl: "http://127.0.0.1:1", timeoutMs: options.timeoutMs });
  let baselineChecks: GeneralRun;
  let baselineReproduction: SandboxCommandResult | null = null;
  await withAbortDestroy(baseline, options.signal, async () => {
    await prepareSession(baseline, options.source, options.timeoutMs, options.signal);
    baselineChecks = await runGeneralChecks(baseline, options.source, options.timeoutMs, options.signal);
    if (testPatch && options.reproductionCommand) {
      await applyPatch(baseline, testPatch, options.timeoutMs, options.signal);
      baselineReproduction = await runReproduction(baseline, options.reproductionCommand, options.timeoutMs, options.signal);
    }
  });

  assertNotAborted(options.signal);
  const patched = await options.sandboxProvider.create({ taskId: `${options.taskId}-patched`, repository: options.source.repository, gatewayUrl: "http://127.0.0.1:1", timeoutMs: options.timeoutMs });
  let patchedChecks: GeneralRun;
  let patchedReproduction: SandboxCommandResult | null = null;
  await withAbortDestroy(patched, options.signal, async () => {
    await prepareSession(patched, options.source, options.timeoutMs, options.signal);
    await applyPatch(patched, options.patch, options.timeoutMs, options.signal);
    patchedChecks = await runGeneralChecks(patched, options.source, options.timeoutMs, options.signal);
    if (testPatch && options.reproductionCommand) patchedReproduction = await runReproduction(patched, options.reproductionCommand, options.timeoutMs, options.signal);
  });

  const checks: VerificationCheck[] = [];
  for (const [name, command] of [["test", options.source.commands.test], ["build", options.source.commands.build]] as const) {
    if (!command) continue;
    const before = baselineChecks!.checks.get(name);
    const after = patchedChecks!.checks.get(name);
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

  const baselineClassification = classifyReproduction(baselineReproduction);
  const patchedClassification = classifyReproduction(patchedReproduction);
  const reproduced = Boolean(testPatch && options.reproductionCommand && baselineClassification === "assertion_failure" && patchedClassification === "passed");
  const reason = reproduced ? null : !testPatch ? "Patch contains no test-file hunks for reproduce-first proof." : !options.reproductionCommand ? "No focused reproduction command could be derived from the added test." : baselineClassification !== "assertion_failure" ? "Baseline did not fail with an assertion failure." : "Patched reproduction test did not pass.";
  const reproduce: ReproduceProof = {
    command: options.reproductionCommand,
    baselineExitCode: baselineReproduction?.exitCode ?? null,
    patchedExitCode: patchedReproduction?.exitCode ?? null,
    baselineOutput: output(baselineReproduction),
    patchedOutput: output(patchedReproduction),
    baselineClassification,
    patchedClassification,
    reproduced,
    reason,
  };

  return { checks, hasNewFailures: checks.some((check) => check.status === "failed"), reproduce };
}
