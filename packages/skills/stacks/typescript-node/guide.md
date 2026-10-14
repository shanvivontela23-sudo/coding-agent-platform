Work with the repository's existing Node.js package manager, workspace layout, module system, and TypeScript settings. Treat package manifests, lockfiles, scripts, runner configuration, and nearby tests as the source of truth.

Keep changes narrow and consistent with existing patterns. Do not introduce a dependency or rewrite configuration unless the approved task requires it. Preserve ESM or CommonJS conventions already used by the repository, including file-extension rules.

For bug fixes, add the smallest focused regression test supported by the detected runner. Use the provided runner-specific command when available. If no focused command is configured, use the provided full test command. Do not invent a script that is absent from the repository.

Use the provided install, test, build, and lint commands as hints exactly when present. Lint is advisory during implementation; final verification is controlled separately. Address failures caused by the change, and distinguish them from failures that already exist on the approved baseline.
