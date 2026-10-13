import { describe, expect, it } from "vitest";
import { describeRunnerFailure, redactSecrets } from "../src/task-execution-worker.js";

describe("runner failure logging", () => {
  it("keeps the real cause so a failed paid run can be diagnosed", () => {
    const entry = describeRunnerFailure("exec-1", "worker-1", new Error("400: invalid denied CIDR ::/0"));
    expect(entry.event).toBe("execution_runner_failed");
    expect(entry.executionId).toBe("exec-1");
    expect(entry.error.message).toBe("400: invalid denied CIDR ::/0");
  });

  it("redacts tokens, bearer headers, database passwords and private keys", () => {
    const raw = [
      "key sk-ant-api03-abcdefghijklmnop",
      "e2b_0123456789abcdef0123",
      "ghs_ABCDEFGHIJKLMNOP1234",
      "Authorization: Bearer abc.def.ghijklmnop",
      "postgresql://coding_agent_worker:supersecret@localhost:5432/db",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ].join(" ");
    const redacted = redactSecrets(raw);
    for (const secret of ["abcdefghijklmnop", "0123456789abcdef0123", "ABCDEFGHIJKLMNOP1234", "abc.def.ghijklmnop", "supersecret", "MIIEow"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("postgresql://coding_agent_worker:[REDACTED]@localhost");
  });

  it("handles non-Error throws", () => {
    expect(describeRunnerFailure("e", "w", "boom").error).toEqual({ name: "NonError", message: "boom" });
  });
});
