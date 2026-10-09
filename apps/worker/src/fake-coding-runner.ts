import type { ClaimedExecution } from "./postgres-execution-queue.js";
import type { CodingRunner } from "./task-execution-worker.js";

export class FakeCodingRunner implements CodingRunner {
  constructor(private readonly options: { readonly delayMs?: number; readonly fail?: boolean } = {}) {}

  async run(_execution: ClaimedExecution, options: { readonly signal: AbortSignal }): Promise<void> {
    if (options.signal.aborted) throw new Error("execution aborted");
    const delayMs = this.options.delayMs ?? 0;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        const abort = () => { clearTimeout(timer); reject(new Error("execution aborted")); };
        options.signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (options.signal.aborted) throw new Error("execution aborted");
    if (this.options.fail) throw new Error("fake coding runner failed");
  }
}
