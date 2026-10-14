import { describe, expect, it } from "vitest";
import { isTestPath } from "../src/patch-parser.js";

describe("test file detection across stacks", () => {
  it.each([
    "src/retry.test.ts", "tests/test_refunds.py", "app/test_refunds.py", "app/refunds_test.py",
    "src/test/java/demo/RefundServiceTest.java", "service/RefundServiceIT.java", "lib/AppTest.kt",
    "tests/Demo.Tests/RefundServiceTests.cs", "Demo.UnitTests/Thing.cs", "src/Demo.Tests/Helpers.cs",
  ])("recognizes %s", (path) => { expect(isTestPath(path)).toBe(true); });

  it.each([
    "src/retry.ts", "app/refunds.py", "app/contest.py", "src/main/java/demo/Contest.java",
    "src/main/java/demo/TestUtilities.java", "src/Demo/Testing.cs", "src/Demo/Program.cs",
  ])("does not treat %s as a test", (path) => { expect(isTestPath(path)).toBe(false); });
});
