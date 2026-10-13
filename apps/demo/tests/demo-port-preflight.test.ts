import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { assertDemoPortFree } from "../src/preflight.js";

const ipv6NotApplicableCodes = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function busyMessage(port: number): string {
  return `Port ${port} is already in use; stop the process using it (\`lsof -iTCP:${port} -sTCP:LISTEN\`)`;
}

async function listen(host?: "127.0.0.1" | "::1"): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("test server did not expose a TCP port");
  }
  return { server, port: address.port };
}

async function tryListenIpv6(): Promise<{ server: Server; port: number } | null> {
  try {
    return await listen("::1");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ipv6NotApplicableCodes.has(code)) return null;
    throw error;
  }
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("demo port availability", () => {
  it("reports an IPv4 loopback-only listener as busy", async () => {
    const { server, port } = await listen("127.0.0.1");
    try {
      await expect(assertDemoPortFree(port)).rejects.toThrow(busyMessage(port));
    } finally {
      await close(server);
    }
  });

  it("reports an IPv6 loopback-only listener as busy when IPv6 is available", async (context) => {
    const listener = await tryListenIpv6();
    if (!listener) {
      context.skip();
      return;
    }
    try {
      await expect(assertDemoPortFree(listener.port)).rejects.toThrow(busyMessage(listener.port));
    } finally {
      await close(listener.server);
    }
  });

  it("reports a wildcard listener as busy", async () => {
    const { server, port } = await listen();
    try {
      await expect(assertDemoPortFree(port)).rejects.toThrow(busyMessage(port));
    } finally {
      await close(server);
    }
  });

  it("reports the port free after the listener closes", async () => {
    const { server, port } = await listen("127.0.0.1");
    await close(server);
    await expect(assertDemoPortFree(port)).resolves.toBeUndefined();
  });
});
