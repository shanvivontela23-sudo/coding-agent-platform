import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// In share mode NEXT_PUBLIC_API_ORIGIN is the public tunnel. Server-side
// fetches must use the local API_INTERNAL_ORIGIN, or every page load leaves the
// machine and the polled execution route is rate-limited (seen live: HTTP 429).
describe("web server API calls", () => {
  const files = execFileSync("grep", ["-rl", "NEXT_PUBLIC_API_ORIGIN", "apps/web/app", "apps/web/components", "apps/web/src"], { encoding: "utf8" }).trim().split("\n");

  it.each(files)("%s fetches the API through the internal origin", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/fetch\(`\$\{apiOrigin\}/);
    if (/fetch\(`\$\{serverApiOrigin\}/.test(source)) expect(source).toContain("process.env.API_INTERNAL_ORIGIN?.trim() || apiOrigin");
  });
});
