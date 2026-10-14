import type { TemplateBuilder } from "e2b";
import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "./typescript-node/template.js";

// The coding harness (Node + Codex + Claude Code + git) that every stack
// template adds on top of its language image. Node comes from the official
// tarball so non-Node images get the same Node major as the TypeScript template.
export const HARNESS_NODE_VERSION = "22.11.0" as const;

export function withCodingHarness(template: TemplateBuilder): TemplateBuilder {
  return template
    .aptInstall(["git", "curl", "ca-certificates", "xz-utils", "unzip"], { noInstallRecommends: true })
    .runCmd(`curl -fsSL https://nodejs.org/dist/v${HARNESS_NODE_VERSION}/node-v${HARNESS_NODE_VERSION}-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1`, { user: "root" })
    .runCmd(`npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION}`, { user: "root" })
    .runCmd("node --version && claude --version && codex --version && git --version");
}
