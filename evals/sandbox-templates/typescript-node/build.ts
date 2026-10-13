// Builds the pinned TypeScript/Node harness template on E2B and prints its id.
// Usage (from repo root, E2B_API_KEY in the environment):
//   pnpm exec tsx evals/sandbox-templates/typescript-node/build.ts
// Put the printed id in .env as E2B_TEMPLATE_ID. Building costs E2B build
// time only; it makes no model calls.
import { Template, defaultBuildLogger } from "e2b";
import { CODEX_VERSION, CLAUDE_CODE_VERSION, typescriptNodeHarnessTemplate } from "./template.js";

async function main(): Promise<void> {
  const name = process.env.E2B_TEMPLATE_NAME?.trim() || "dhara-typescript-node";
  if (!process.env.E2B_API_KEY?.trim()) throw new Error("E2B_API_KEY is required");

  const info = await Template.build(typescriptNodeHarnessTemplate, name, {
    tags: [`codex-${CODEX_VERSION}`, `claude-code-${CLAUDE_CODE_VERSION}`],
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });

  // Pin by version tag: a bare id resolves to the "default" tag, which this
  // build does not create ("404: tag 'default' does not exist"), and a moving
  // tag could silently change the harness the demo runs.
  console.log(`E2B_TEMPLATE_ID=${info.name}:codex-${CODEX_VERSION}`);
  console.log(`template id: ${info.templateId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
