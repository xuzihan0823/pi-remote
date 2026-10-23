import { loadConfig } from "./config.ts";
import { RelayServer } from "./relay/server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new RelayServer({ config });
  const address = await server.start();
  if (config.agentToken === config.relayToken) {
    console.warn("warning: AGENT_TOKEN is unset or equals RELAY_TOKEN; anyone holding the phone token can register as the Mac agent. Set a separate AGENT_TOKEN on the relay and the Mac agent.");
  }

  console.log(`pi-remote relay is listening on http://${address.host}:${address.port}`);
  console.log(`  health   GET  http://${address.host}:${address.port}/api/health`);
  console.log(`  ios      WS   ws://${address.host}:${address.port}/ws/ios (Authorization: Bearer RELAY_TOKEN)`);
  console.log(`  agent    WS   ws://${address.host}:${address.port}/ws/agent (Authorization: Bearer AGENT_TOKEN)`);
  console.log(`  workspace root: ${config.piWorkspaceRoot} (pi: ${config.piBin}, max sessions: ${config.maxSessions})`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    try {
      await server.stop();
    } catch (error) {
      console.error(`error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
