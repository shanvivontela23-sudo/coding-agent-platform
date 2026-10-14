# Stack fixtures

Small public sample repositories, one per stack skill, each with the same known
refund bug and a support-style `TICKET.md`. They are used to check that a stack
skill's detected commands install, test and run a single test on the real
toolchain, and later for with/without-skill cost comparisons.

They are **not** the Phase 0 benchmark (see `evals/dataset/README.md`); nothing
here is sealed or held out.

| Fixture | Stack skill | Bug |
| --- | --- | --- |
| `python-refunds` | `python` (pip + pytest) | a second partial refund is capped at the original payment instead of the remaining balance |
| `java-refunds` | `java-spring` (Maven + JUnit 5) | same |
| `dotnet-refunds` | `dotnet` (xUnit) | same |
