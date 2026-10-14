// Builds one stack's harness template on E2B and prints the .env line for it.
// Usage (from repo root, E2B_API_KEY in the environment):
//   pnpm exec tsx evals/sandbox-templates/build-stack.ts python|java|dotnet
// Building costs E2B build time only; it makes no model calls. Leaving the
// printed variable unset keeps that stack on E2B_TEMPLATE_ID.
import { Template, defaultBuildLogger, type TemplateBuilder } from "e2b";
import { CODEX_VERSION } from "./typescript-node/template.js";
import { dotnetHarnessTemplate } from "./dotnet/template.js";
import { javaHarnessTemplate } from "./java/template.js";
import { pythonHarnessTemplate } from "./python/template.js";

export const stackTemplates: Readonly<Record<string, { readonly template: TemplateBuilder; readonly envName: string; readonly memoryMB: number }>> = {
  python: { template: pythonHarnessTemplate, envName: "E2B_TEMPLATE_PYTHON", memoryMB: 2048 },
  java: { template: javaHarnessTemplate, envName: "E2B_TEMPLATE_JAVA", memoryMB: 4096 },
  dotnet: { template: dotnetHarnessTemplate, envName: "E2B_TEMPLATE_DOTNET", memoryMB: 4096 },
};

async function main(): Promise<void> {
  const stack = process.argv[2] ?? "";
  const selected = stackTemplates[stack];
  if (!selected) throw new Error(`Usage: build-stack.ts ${Object.keys(stackTemplates).join("|")}`);
  if (!process.env.E2B_API_KEY?.trim()) throw new Error("E2B_API_KEY is required");
  const name = `dhara-${stack}`;
  const info = await Template.build(selected.template, name, { tags: [`codex-${CODEX_VERSION}`], cpuCount: 2, memoryMB: selected.memoryMB, onBuildLogs: defaultBuildLogger() });
  console.log(`${selected.envName}=${info.name}:codex-${CODEX_VERSION}`);
}

if (process.argv[1]?.endsWith("build-stack.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
