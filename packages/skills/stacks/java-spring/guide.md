Work with the repository's existing build tool (Maven or Gradle, preferring its wrapper), Java or Kotlin version, Spring Boot version and package structure. Treat pom.xml or build.gradle, application configuration and nearby tests as the source of truth.

Keep changes narrow. Do not upgrade Spring Boot, the JDK target or plugins, and do not add dependencies unless the approved task requires it. Follow the project's existing patterns for controllers, services, repositories, dependency injection (prefer constructor injection where the code already does) and exception handling.

For bug fixes, add the smallest focused JUnit test in the matching src/test package, named after the class under test (for example RefundServiceTest). Prefer a plain unit test or the project's existing slice tests over a full @SpringBootTest. Tests run without network access, so never depend on live databases, brokers or HTTP; use the project's existing test configuration, mocks or in-memory setup.

Use the provided install, test and build commands exactly when present; they run the wrapper through sh. Distinguish failures caused by the change from failures that already exist on the approved baseline.
