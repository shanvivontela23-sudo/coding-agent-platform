import { Template } from "e2b";
import { withCodingHarness } from "../harness.js";

// JDK 21 (compiles projects targeting 17 and 21) with Maven and Gradle for
// repositories without a wrapper. Pin the base image by digest before production use.
export const JAVA_BASE_IMAGE = "eclipse-temurin:21-jdk-jammy" as const;
export const MAVEN_VERSION = "3.9.9" as const;
export const GRADLE_VERSION = "8.10.2" as const;

export const javaHarnessTemplate = withCodingHarness(Template().fromImage(JAVA_BASE_IMAGE))
  .runCmd(`curl -fsSL https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz | tar -xz -C /opt && ln -sf /opt/apache-maven-${MAVEN_VERSION}/bin/mvn /usr/local/bin/mvn`, { user: "root" })
  .runCmd(`curl -fsSL -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip && unzip -q /tmp/gradle.zip -d /opt && rm /tmp/gradle.zip && ln -sf /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle`, { user: "root" })
  .runCmd("java -version && mvn -version && gradle --version");
