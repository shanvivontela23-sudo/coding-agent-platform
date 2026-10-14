import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";

// Sessions are host-only cookies. Locally, localhost:3000 and localhost:3101
// share them; behind two public hostnames they would not, and sign-in would
// silently fail. DEMO_SHARE therefore serves web and API from ONE public
// origin, routing each request to the right local process.
export type ShareTarget = "api" | "web";

const webOwnedApiRoute = /^\/api\/tasks\/[^/]+\/execution$/; // Next.js route handler

export function routeShareRequest(method: string, rawPath: string): ShareTarget {
  const path = rawPath.split("?")[0] ?? "/";
  if (webOwnedApiRoute.test(path)) return "web";
  // GET routes the API serves outside /api and /auth (a GET form and a download link).
  if (path.startsWith("/api/") || path.startsWith("/auth/") || path === "/health" || path === "/projects/download" || path === "/github/connect/start") return "api";
  // Pages are GET; every form post (/projects/..., /tasks/..., /members/...) goes to the API.
  if (method !== "GET" && method !== "HEAD") return "api";
  return "web";
}

function forwardedHeaders(request: IncomingMessage, publicHost: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers[name] = value;
  headers["x-forwarded-host"] = publicHost;
  headers["x-forwarded-proto"] = "https";
  return headers;
}

export function startShareProxy(options: { readonly port: number; readonly apiPort: number; readonly webPort: number }): Promise<Server> {
  const portFor = (target: ShareTarget) => (target === "api" ? options.apiPort : options.webPort);
  const server = createServer((request, response) => {
    const target = routeShareRequest(request.method ?? "GET", request.url ?? "/");
    const upstream = httpRequest(
      { host: "127.0.0.1", port: portFor(target), method: request.method, path: request.url, headers: forwardedHeaders(request, String(request.headers.host ?? "")) },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("Dhara is starting or not running.");
    });
    request.pipe(upstream);
  });
  // Next.js dev uses a websocket for hot reload; pass upgrades straight to the web app.
  server.on("upgrade", (request, socket, head) => {
    const upstream = connect(options.webPort, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on("error", close);
    socket.on("error", close);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve(server));
  });
}
