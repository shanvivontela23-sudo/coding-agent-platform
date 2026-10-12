import { describe, expect, it } from "vitest";
import { createGitHubInstallationPermissionReader } from "../src/github-installation-permissions.js";

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

describe("GitHub installation permission preflight", () => {
  it.each([["write", "write"], ["read", "read"], [undefined, "none"]] as const)("maps contents %s to %s", async (contents, expected) => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/app/installations/777");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-jwt");
      return response({ permissions: contents ? { contents } : {} });
    };
    const reader = createGitHubInstallationPermissionReader({ appId: "123", privateKey: "unused", createAppJwt: () => "test-jwt", fetchImpl });
    await expect(reader.getInstallationPermissions(777)).resolves.toEqual({ contents: expected });
  });
});
