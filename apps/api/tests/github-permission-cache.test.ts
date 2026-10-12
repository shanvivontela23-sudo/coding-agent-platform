import { describe, expect, it, vi } from "vitest";
import { createGitHubInstallationPermissionReader } from "../src/github-installation-permissions.js";

function response(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }

describe("GitHub installation permission cache", () => {
  it("caches per installation for five minutes and supports an explicit bypass", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ permissions: { contents: "write" } }));
    const reader = createGitHubInstallationPermissionReader({
      appId: "123",
      privateKey: "unused",
      createAppJwt: () => "test-jwt",
      fetchImpl,
      nowMs: () => now,
    });

    await reader.getInstallationPermissions(777);
    await reader.getInstallationPermissions(777);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 4 * 60_000;
    await reader.getInstallationPermissions(777);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await reader.getInstallationPermissions(777, { bypassCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 5 * 60_000 + 1;
    await reader.getInstallationPermissions(777);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
