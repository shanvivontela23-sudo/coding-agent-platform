Work with the repository's existing solution layout, target framework, C# language version, nullable settings and test framework (xUnit, NUnit or MSTest). Treat the .sln and .csproj files, Directory.Build.props and nearby tests as the source of truth.

Keep changes narrow. Do not retarget frameworks, upgrade packages or add NuGet references unless the approved task requires it. Follow the project's existing patterns for dependency injection, async/await, nullability and exception handling, and keep public APIs compatible.

For bug fixes, add the smallest focused test in the existing test project, in a class named after the type under test (for example RefundServiceTests), using that project's framework and assertion style. Tests run without network access, so never depend on live databases or HTTP; use the project's existing fakes, mocks or in-memory providers.

Use the provided restore, test and build commands exactly when present; build and test run with --no-restore after the restore step. Distinguish failures caused by the change from failures that already exist on the approved baseline.
