import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DemoConfig } from "../src/config.js";
import { createDemoLaunchPlan } from "../src/launcher.js";
import { routeShareRequest, startShareProxy } from "../src/share-proxy.js";

describe("share proxy routing", () => {
  it.each([
    ["GET", "/", "web"],
    ["GET", "/home", "web"],
    ["GET", "/tasks/abc", "web"],
    ["GET", "/projects/abc/tasks/new", "web"],
    ["GET", "/_next/static/chunk.js", "web"],
    ["GET", "/api/tasks/abc/execution", "web"],
    ["POST", "/api/tasks/abc/execution", "web"],
    ["GET", "/api/home", "api"],
    ["GET", "/api/tasks/abc", "api"],
    ["GET", "/api/tasks/abc/execution/zip-result/patch", "api"],
    ["POST", "/auth/email", "api"],
    ["GET", "/auth/github/start", "api"],
    ["GET", "/auth/github/callback?code=x", "api"],
    ["GET", "/github/connect/start", "api"],
    ["GET", "/projects/download?token=t", "api"],
    ["POST", "/projects/abc/tasks", "api"],
    ["POST", "/tasks/abc/answers", "api"],
    ["POST", "/members/invitations", "api"],
    ["POST", "/onboarding/organization", "api"],
  ] as const)("%s %s -> %s", (method, path, target) => {
    expect(routeShareRequest(method, path)).toBe(target);
  });
});

describe("share proxy", () => {
  const servers: Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

  async function listen(name: string): Promise<number> {
    const server = createServer((request, response) => {
      response.setHeader("set-cookie", `${name}_seen=1; Path=/`);
      response.end(JSON.stringify({ name, method: request.method, url: request.url, host: request.headers["x-forwarded-host"] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return (server.address() as AddressInfo).port;
  }

  it("serves web and API from one origin, keeping cookies and the public host", async () => {
    const [apiPort, webPort] = [await listen("api"), await listen("web")];
    const proxy = await startShareProxy({ port: 0, apiPort, webPort });
    servers.push(proxy);
    const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    const page = await fetch(`${base}/tasks/abc`, { headers: { host: "demo.trycloudflare.com" } });
    expect(await page.json()).toMatchObject({ name: "web", url: "/tasks/abc" });

    const post = await fetch(`${base}/tasks/abc/answers`, { method: "POST", body: "a=1", redirect: "manual" });
    expect(await post.json()).toMatchObject({ name: "api", method: "POST" });
    expect(post.headers.get("set-cookie")).toContain("api_seen=1");
  });
});

describe("launch plan in share mode", () => {
  const config = {
    apiPort: 3101,
    webPort: 3000,
    planningBudgetUsd: 1,
    executionBudgetUsd: 2,
    values: {},
  } as unknown as DemoConfig;

  it("points API, web and browser forms at the one public origin", () => {
    const plan = createDemoLaunchPlan(config, "https://gateway.example.dev", "/repo", "https://abc.trycloudflare.com");
    expect(plan.api.env.API_ORIGIN).toBe("https://abc.trycloudflare.com");
    expect(plan.api.env.WEB_ORIGIN).toBe("https://abc.trycloudflare.com");
    expect(plan.web.env.NEXT_PUBLIC_API_ORIGIN).toBe("https://abc.trycloudflare.com");
    expect(plan.web.env.NEXT_ALLOWED_DEV_ORIGINS).toBe("abc.trycloudflare.com");
    // Server-side web fetches stay local instead of looping through the tunnel.
    expect(plan.web.env.API_INTERNAL_ORIGIN).toBe("http://127.0.0.1:3101");
  });

  it("keeps localhost origins when not sharing", () => {
    const plan = createDemoLaunchPlan(config, "https://gateway.example.dev", "/repo");
    expect(plan.api.env.API_ORIGIN).toBe("http://localhost:3101");
    expect(plan.web.env.NEXT_PUBLIC_API_ORIGIN).toBe("http://localhost:3101");
    expect(plan.web.env.NEXT_ALLOWED_DEV_ORIGINS).toBeUndefined();
  });

  it("rejects a non-HTTPS or path-bearing share origin", () => {
    expect(() => createDemoLaunchPlan(config, "https://gateway.example.dev", "/repo", "http://abc.trycloudflare.com")).toThrow();
    expect(() => createDemoLaunchPlan(config, "https://gateway.example.dev", "/repo", "https://abc.trycloudflare.com/x")).toThrow();
  });
});
