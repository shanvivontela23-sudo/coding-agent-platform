import {
  createGatewayServerRuntime,
  loadGatewayServerConfig,
} from "./server.js";

async function main(): Promise<void> {
  const config = loadGatewayServerConfig();
  const runtime = createGatewayServerRuntime(config);
  await runtime.listen();
  console.error(`harness gateway listening on ${config.host}:${config.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.closeGracefully();
    } catch (error) {
      console.error(error instanceof Error ? error.message : "gateway shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "gateway startup failed");
  process.exitCode = 1;
});
