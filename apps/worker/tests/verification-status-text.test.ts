import { describe, expect, it } from "vitest";
import { describeCompletedVerification } from "../src/product-execution-orchestrator.js";

// Live runs 2026-10-13: the change note's Verification status was always
// "Verification completed with at least one passing baseline test or build."
describe("verification status in the change note", () => {
  it("names each check and its outcome on the clean copy", () => {
    expect(describeCompletedVerification([{ name: "test", status: "passed" }, { name: "build", status: "passed" }]))
      .toBe("Verified on a clean copy of the approved source with the patch applied: test passed, build passed.");
  });

  it("explains pre-existing failures in plain words", () => {
    expect(describeCompletedVerification([{ name: "test", status: "pre_existing" }])).toContain("test failing before and after (pre-existing)");
  });

  it("says when no check was configured", () => {
    expect(describeCompletedVerification([])).toContain("no test or build command was configured");
  });
});
