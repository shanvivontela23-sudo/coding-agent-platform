import { describe, expect, it, vi } from "vitest";
import { cleanupUnadoptedZipResult } from "../src/zip-result-builder.js";

describe("ZIP result ownership-loss cleanup", () => {
  it("deletes exactly the candidate storage object when completion reports lost", async () => {
    const deleteVersion = vi.fn(async () => undefined);
    await expect(cleanupUnadoptedZipResult("lost", "org/project/candidate.zip", deleteVersion)).rejects.toThrow(
      "ZIP result build ownership was lost before completion.",
    );
    expect(deleteVersion).toHaveBeenCalledTimes(1);
    expect(deleteVersion).toHaveBeenCalledWith("org/project/candidate.zip");
  });

  it("deletes an unneeded candidate when another artifact already won without treating it as a failure", async () => {
    const deleteVersion = vi.fn(async () => undefined);
    await expect(cleanupUnadoptedZipResult("existing", "org/project/candidate.zip", deleteVersion)).resolves.toBeUndefined();
    expect(deleteVersion).toHaveBeenCalledTimes(1);
  });
});
