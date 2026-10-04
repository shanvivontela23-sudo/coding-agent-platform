# Phase 0 dataset

The real Phase 0 evaluation dataset is **not committed to this public repository**.

That is deliberate:

- hidden reference tests must never be visible to the coding harness;
- held-out ticket text must remain sealed from anyone tuning instructions or skills;
- canary values and adversarial fixture payloads must never be published;
- public source-repository URLs, issue identifiers, reference-fix metadata and cryptographic commitments may be recorded, but private benchmark payloads live outside the repository.

## Manifest contract

The validator expects:

- 40 normal bug tasks;
- 10 tasks per stack;
- per stack: 4 easy, 4 medium and 2 hard;
- per stack: 7 development and 3 held-out;
- 8 adversarial cases total, 2 per stack;
- exactly one case for each adversarial scenario defined by the Phase 0 specification.

Development ticket text may be present in a manifest used by the internal benchmark team. Held-out ticket text must be represented only by a sealed artifact reference. Hidden tests are always represented by a sealed artifact reference.

A sealed artifact reference contains only an opaque artifact ID and a SHA-256 digest. The benchmark collector will resolve that ID from a private artifact store outside the agent sandbox.

## Validation

```bash
pnpm dataset:validate /path/to/phase-0.manifest.json
```

The CLI validates both the JSON schema and the experimental-design invariants. It does **not** fetch private artifacts or source repositories.

## Public-repo rule

Do not commit:

- the real held-out ticket payloads;
- hidden tests;
- adversarial fixture contents;
- canary values;
- customer/private repository material;
- API keys or credentials.
