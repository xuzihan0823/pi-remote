import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveTerminalExecutable } from "../src/terminal/launcher.ts";

const run = promisify(execFile);
test("native child identities and auth fallback remain independent across actual main model switches in RPC and terminal modes", { skip: process.env.PI_STRICT_RUNTIME !== "1", timeout: 150_000 }, async () => {
  const bun = await resolveTerminalExecutable("bun");
  const result = await run(bun, ["tests/helpers/subagent-model-isolation.mjs"], { timeout: 140_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
});
