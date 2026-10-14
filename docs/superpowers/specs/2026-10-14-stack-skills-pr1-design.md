# Dhara Stack Skills PR 1 Design

## Goal

Add a built-in, versioned TypeScript/Node stack skill that Dhara can use during repository analysis, planning, implementation, verification, and sandbox selection without weakening repository evidence, prompt trust boundaries, reproduce-first proof, or existing-report compatibility.

This is PR 1 of four. It establishes the framework and one skill only. Project memory, additional stacks, and organization skills remain out of scope until their preceding PRs are merged and reviewed.

## Fixed constraints

- Base commit: `a7b9841db1b086f4ad8863b964ff20b7227875f5`.
- Work in an isolated worktree and open one PR; do not merge it.
- Use the repository's current ESM/NodeNext conventions and `.js` import specifiers.
- No paid model calls, live E2B runs, or template builds.
- Do not edit migrations `0001` through `0012`; add `0013` and its SHA-256 checksum if persistence changes are needed.
- Before opening the PR, run lint, typecheck, and the complete `pnpm test:parallel` suite.
- Preserve PII masking, encrypted ticket storage, untrusted-content wrapping, exact-bytes publication, reproduce-first proof, no-auto-merge behavior, and existing spend controls.

## Shared skill package

Create a source-only shared module at `packages/skills/`. Both the API and worker need the same definitions, so putting the registry under either application would create the wrong dependency direction. The repository already typechecks `packages/**/*.ts`; this PR does not introduce a separately published package or a new workspace build.

The layout is:

```text
packages/skills/
  src/
    schema.ts
    registry.ts
    resolution.ts
    prompt.ts
    index.ts
  stacks/
    typescript-node/
      skill.json
      guide.md
  tests/
    schema.test.ts
    registry.test.ts
    resolution.test.ts
    prompt.test.ts
```

All built-in assets are located with `new URL(..., import.meta.url)`, never `process.cwd()`. Tests must prove loading works while the process working directory is outside the repository root.

## Skill schema

Use Zod, which is already a root dependency and the repository's established choice for structured configuration validation.

Each `skill.json` contains:

- `id`, `version`, and `displayName`;
- `detect.manifests` and `detect.markers`;
- `sandboxTemplate`;
- `defaults.install`, `defaults.build`, `defaults.test`, optional `defaults.lint`, and runner-specific `defaults.testSingle` templates;
- an ordered `verification` list, where each check names a command role and its environment-failure output patterns;
- optional positive timeout limits.

The TypeScript/Node `testSingle` map has separate templates for `vitest`, `jest`, `mocha`, and `node:test`. Every template contains exactly one `{path}` placeholder. Unknown runners have no focused template.

Validation rejects unknown keys, duplicate ids or id/version pairs, empty command text, invalid versions, invalid or repeated check names, malformed patterns, unsafe or missing `{path}` placeholders, non-positive limits, and guides over the hard 1,500-token cap. Token measurement uses the same conservative UTF-8-byte estimate already used by gateway reservation rather than adding a tokenizer dependency.

`loadBuiltInStackSkills()` loads and validates every built-in JSON/guide pair. API and real-worker composition both invoke it during startup. A malformed built-in prevents either process from starting. A separate unit test loads the complete built-in directory so the same failure is caught in CI.

## Detection and command precedence

`analyseRepositoryEntries()` supplies normalized manifest paths, safe manifest contents, language evidence, package-manager evidence, scripts, and dependency names to the registry. The registry returns a primary skill plus a detected test runner when evidence is sufficient.

Command resolution is field-by-field:

1. A repository-derived command wins.
2. A skill default is eligible only when repository evidence proves it can run.
3. Otherwise the resolved command stays `null`.

For TypeScript/Node:

- a package-manager install default requires matching package-manager/manifest evidence;
- a build default requires a declared build script or an explicitly detected build tool configuration;
- a test default requires a declared test script or a detected supported runner;
- a runner-specific single-test template requires positive detection of that exact runner;
- lint is used only when a matching script or tool is detected.

The resolver never invents `pnpm test`, `npm test`, or another command merely because a repository is TypeScript/Node. If a skill-sourced command later fails because its script, executable, or toolchain is unavailable, verification treats that as environment/setup failure, not a code regression.

## Project report compatibility

Keep `ProjectReport.stackSkill` as a string so current API, database JSON, and web rendering remain compatible. Add only optional fields:

- `stackSkillVersion`;
- `commandSources`, keyed by command role with values `"repo"` or `"skill"`;
- `testRunner`;
- `testSingleCommand`;
- optional lint and verification metadata required by execution;
- optional stack display/template metadata required by the UI and worker.

Existing rows containing only `stackSkill: "typescript-node" | "generic"` and existing install/test/build fields remain readable without re-analysis. Their stored commands remain authoritative. An old report may receive current trusted guidance by id, but it receives a focused single-test template only when its stored report contains enough runner evidence. Current legacy reports generally do not, so they retain today's safe full-test-command behavior.

A report with no matching skill remains `stackSkill: "generic"`. The project UI displays: `No stack skill for this project. Dhara will work it out, which may be slower.`

## Planning prompt

Resolve the report's skill before clarification and plan generation. Add a stable trusted stack-skill prefix to the system message in this order:

1. fixed planner safety/role instructions;
2. built-in stack guide and its id/version;
3. fixed output contract;
4. per-task user content.

The built-in guide is code-owned trusted static text. It is never placed inside `<UNTRUSTED_REPOSITORY_CONTEXT>`. Ticket, repository context, and all repository-derived values remain in their existing untrusted blocks. No task-specific value may precede or be interpolated into the cached skill prefix.

Tests assert the guide is present in clarification and plan system messages at the same stable location, the untrusted wrappers remain intact, and the total added skill prefix stays within its declared token cap.

Persist the skill id and version actually used for the accepted planning flow. Planning retries update the accepted planning metadata; the eventual execution snapshot copies that planning id/version so measurement distinguishes planning from implementation.

## Execution profile and persistence

Add migration `0013_stack_skill_execution_profile.sql` and its checksum. Existing columns remain untouched. The migration adds nullable planning-skill metadata to `tasks` and nullable execution-profile metadata to `task_executions`, including:

- planning skill id/version;
- implementation skill id/version;
- the final pinned sandbox template id;
- resolved command values and command sources;
- runner/single-test and ordered verification configuration needed by this execution.

The execution profile is resolved once, before any coding model call. It is persisted before a sandbox is allowed to start. A reclaimed worker loads the stored profile instead of resolving against possibly changed built-in files or environment configuration.

The profile contains immutable values for that execution: skill id/version, planning skill id/version, commands, command sources, detected runner, single-test template, ordered verification checks, timeouts, the bounded guide text snapshot, and sandbox template id. Persisting the guide snapshot prevents a reclaimed execution from silently receiving different instructions after a deployment. Implementation, baseline verification, and patched verification all receive the same profile.

If the preferred skill template is absent, resolution chooses `E2B_TEMPLATE_ID` immediately. If E2B rejects the preferred id with its typed template-not-found response before creating a sandbox, the worker performs one compare-and-swap replacement of the pinned template with `E2B_TEMPLATE_ID`, then retries once. The fallback is persisted before dependency setup or any model call, and the resulting value is the only template used by implementation and both verification sandboxes. Other sandbox failures are not disguised as missing-template fallback. A missing skill, missing skill version, absent template setting, or legacy report never blocks a run; it uses generic behavior and `E2B_TEMPLATE_ID`.

Measurement data records the versions actually used at planning and implementation, the pinned template, and the source of each command. It does not claim a skill version was used when resolution degraded to generic behavior.

## Implementation prompt and focused reproduction

The coding task contains, in a bounded and deterministic section:

- built-in guide text and skill version;
- exact resolved install, test, build, lint, and focused-test commands that are available;
- the existing approved requirement and plan;
- the existing reproduce-first instruction.

The guide is trusted code-owned content. Requirement and plan retain their current product trust treatment and sanitization boundaries.

For a bug fix, use the runner-specific `testSingle` template when the pinned profile contains one. Otherwise preserve today's fallback of appending the test path to the full test command.

Every path extracted from an untrusted model patch is validated before command construction. Reject absolute paths, normalized paths outside the workspace, any `..` segment, NUL, carriage return, or newline. Substitute the accepted path only through the existing single-argument `shellArg` quoting approach. Tests cover spaces, single quotes, semicolons, traversal, absolute paths, NUL, CR, and LF.

## Verification and failure classification

Verification uses the pinned execution profile and pinned template for both clean sandboxes. It performs dependency setup and then the skill's ordered applicable checks. A check is skipped only when its command is `null`; order is otherwise exact and shared by baseline and patched runs.

Environment-failure patterns are matched against bounded combined command output. Missing scripts, missing executables/toolchains, dependency-network failures, and other configured setup failures yield the existing fail-closed `verification_incomplete` path with clear user-facing wording such as `Dhara couldn't set up the project for verification.` They never become `verification_failed`, `fix_not_reproduced`, or proof of a code regression.

Code/test failures continue through the current baseline-versus-patched comparison and reproduce-first rules. A skill does not relax the requirement for a genuine assertion-style fail-before/pass-after proof.

## UI

On the project report and task page, show a compact `Stack: TypeScript / Node` badge. Its accessible tooltip lists each available command and whether it came from `repo` or `skill`. Generic projects show the explicit fallback message instead of an internal id.

Old reports without command-source metadata display their commands as existing report values without inventing a source label. The UI remains usable when every optional skill field is absent.

Environment/setup failures use non-blaming copy that distinguishes inability to prepare the project from a failed fix. No raw sandbox output, repository content, credentials, or environment values are added to the tooltip or error copy.

## Error handling and security

- Invalid built-ins fail API and worker startup with the skill file/id and schema path, never secret values or guide contents.
- Missing runtime skill/template availability degrades to generic/fallback behavior and is recorded accurately.
- Repository evidence and patch paths remain untrusted data; neither can alter system instructions or shell structure.
- Skill environment patterns classify failures but cannot turn an unverified run into success.
- Prompt growth is bounded and tested at every stage.
- No provider key, GitHub credential, gateway secret, or E2B key enters a skill file, prompt, report, or execution snapshot.

## Test strategy

All tests use fakes and local fixtures.

- Schema tests cover valid config and every fail-loud validation boundary.
- Registry tests load all built-ins from a non-root working directory and prove API/worker startup validation.
- Detection tests cover positive TypeScript/Node evidence, generic fallback, and runner-specific detection.
- Resolution tests prove repo-over-skill precedence, evidence-gated defaults, null commands without evidence, and old-report compatibility.
- Prompt tests cover clarification, planning, and implementation guide placement, trust wrappers, stable prefix ordering, and token caps.
- Execution tests prove one persisted profile is reused after configuration changes and across coding/baseline/patched sandboxes.
- Template tests prove preferred selection, narrowly typed missing-template fallback, and one final pinned template for all three sandboxes.
- Reproduction tests cover Vitest/Jest/Mocha/node:test variants, unknown-runner fallback, safe quoting, and hostile paths.
- Verification tests cover ordered checks plus environment-versus-code failure classification.
- UI tests cover the badge, accessible source tooltip, generic message, and legacy reports with absent optional fields.
- Migration/measurement tests cover nullable backward-compatible columns, immutable old migrations, planning and implementation versions, command sources, and tenant-scoped execution reads.

Before the PR opens, run `pnpm lint`, `pnpm typecheck`, and `pnpm test:parallel`. Do not run `pnpm test:postgres` against the local demo database. The PR description records the migration number, bounded prompt growth per stage, commands run, tests not run, and the owner-only E2B template build command. No template is built or published in this PR.

## Out of scope

- Per-project decision memory.
- Python, Java/Spring, or .NET skills/templates/fixtures.
- Organization-authored skills.
- Live model, E2B, GitHub publication, or demo validation.
- Changes to PR merge behavior or automatic publication.
