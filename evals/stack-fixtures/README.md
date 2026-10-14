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

## Checked on real toolchains (2026-10-14)

Each fixture was run through Dhara's own repository analysis. The detected
commands were then executed the way verification runs them: install with
network, then test, focused test and build with networking switched off
(`docker run --network none` for Java and .NET).

| Stack | Toolchain | Offline baseline tests | Focused test before fix | After fix | Offline build |
| --- | --- | --- | --- | --- | --- |
| Python (pip) | Python 3.13, pytest 8.3 | pass | assertion failure | pass | n/a |
| Python (uv) | uv sync + `uv run pytest` | pass | — | — | n/a |
| Java (Maven) | maven:3.9-eclipse-temurin-21 | pass | assertion failure | pass | pass |
| Java (Gradle) | gradle:8.10-jdk21 | pass | assertion failure | — | pass |
| .NET | dotnet/sdk:8.0, xUnit | pass | assertion failure | pass | pass |

These checks found four problems, now fixed in analysis:
- Maven's `dependency:go-offline` and Gradle's `testClasses` do not fetch test-runtime artifacts (the Surefire JUnit provider, JUnit engine JARs), so offline tests failed. Install now runs the tests once, ignoring their result.
- `python -m pytest` misses uv, Poetry and Pipenv virtualenvs; those now use `uv run` / `poetry run` / `pipenv run`.
- `pipenv sync` skipped dev packages (pytest); it is now `pipenv sync --dev`.

The real failing-test outputs are kept in `apps/worker/tests/fixtures/runner-output/`.
A test asserts that reproduce-first proof reads each one as an assertion failure.
