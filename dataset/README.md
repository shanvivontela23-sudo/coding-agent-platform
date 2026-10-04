# Phase 0 dataset

The real Phase 0 evaluation dataset is **not committed to this public repository**.

That is deliberate:

- hidden reference tests must never be visible to the coding harness;
- held-out ticket text must remain sealed from anyone tuning instructions or skills;
- held-out issue identity and reference-fix metadata must also remain sealed;
- canary values and adversarial fixture payloads must never be published;
- development-task source metadata may be recorded, but private benchmark payloads live outside the repository.

## Manifest contract

The validator expects:

- 40 normal bug tasks;
- 10 tasks per stack;
- per stack: 4 easy, 4 medium and 2 hard;
- per stack: 7 development and 3 held-out;
- 8 adversarial cases total, 2 per stack;
- exactly one case for each adversarial scenario defined by the Phase 0 specification;
- each adversarial kind to carry the exact expected behavior defined by the specification;
- every Git commit identifier to be a full 40-character SHA.

### Development tasks

Development tasks may expose the support-style ticket plus source issue metadata and reference-fix metadata used by the benchmark team.

### Held-out tasks

A public held-out task contains only:

- benchmark identity, stack and difficulty;
- source repository URL and the pinned pre-fix commit;
- an opaque `heldOutArtifact` reference containing an artifact ID and SHA-256 commitment.

The private held-out artifact contains the ticket text, source issue URL/ID/title, reference fix commit/files, reference diff metadata and the hidden-test artifact reference. The public manifest therefore cannot reveal the original issue or reference fix used to construct the held-out case.

The benchmark control plane resolves the private artifact outside the coding-agent sandbox.

## Validation

```bash
pnpm dataset:validate /path/to/phase-0.manifest.json
```

The CLI validates both the JSON schema and the experimental-design invariants. It does **not** fetch private artifacts or source repositories.

## Public-repo rule

Do not commit:

- real held-out artifact payloads;
- hidden tests;
- held-out source issue identity or reference-fix metadata;
- adversarial fixture contents;
- canary values;
- customer/private repository material;
- API keys or credentials.
