import { Template } from "e2b";

export const CLAUDE_CODE_VERSION = "2.0.0" as const;
export const CODEX_VERSION = "0.90.0" as const;

export const typescriptNodeHarnessTemplate = Template()
  .fromImage("node:22-bookworm")
  .runCmd("npm install --global @anthropic-ai/claude-code@2.0.0 @openai/codex@0.90.0")
  .runCmd("claude --version && codex --version");
