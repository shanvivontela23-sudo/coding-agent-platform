import { Template } from "e2b";

export const CLAUDE_CODE_VERSION = "2.1.292" as const;
export const CODEX_VERSION = "0.160.1" as const;
export const TEMPLATE_BASE_IMAGE = "node:22-bookworm@sha256:1caeacc40090c4607170d7508b4eb8d5575a681a1b3a02b9cd65e878fa2d4779" as const;

export const typescriptNodeHarnessTemplate = Template()
  .fromImage(TEMPLATE_BASE_IMAGE)
  // Global npm prefix (/usr/local) is root-owned; E2B runs build steps as
  // `user` by default, which fails with EACCES (npm exit 243).
  .runCmd("npm install --global @anthropic-ai/claude-code@2.1.292 @openai/codex@0.160.1", { user: "root" })
  .runCmd("claude --version && codex --version");
