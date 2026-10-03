import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/install-terminal-bridge.sh", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf-8", env: { ...process.env, ...env } }) as SpawnSyncReturns<string>;
}

function tempExtensionsDir(): string {
  return mkdtempSync(join(tmpdir(), "pbr-ext-"));
}

test("install-terminal-bridge: --help exits cleanly", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--dir/);
  assert.match(result.stdout, /--dry-run/);
});

test("install-terminal-bridge: dry-run writes nothing", () => {
  const dir = tempExtensionsDir();
  const result = run(["--dir", dir, "--dry-run"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[DRY-RUN\]/);
  assert.equal(existsSync(join(dir, "pi-remote-bridge")), false);
});

test("install-terminal-bridge: installs a single self-contained file and keeps other extensions", () => {
  const dir = tempExtensionsDir();
  const sibling = join(dir, "someone-else");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "index.ts"), "// other extension\n");

  const result = run(["--dir", dir]);
  assert.equal(result.status, 0, result.stderr);

  const target = join(dir, "pi-remote-bridge", "index.ts");
  assert.equal(existsSync(target), true);
  assert.match(readFileSync(target, "utf-8"), /pi-remote terminal bridge extension/);
  assert.equal(readFileSync(join(sibling, "index.ts"), "utf-8"), "// other extension\n");

  // Re-installing over our own file is allowed.
  const second = run(["--dir", dir]);
  assert.equal(second.status, 0, second.stderr);
});

test("install-terminal-bridge: refuses to overwrite a foreign extension unless --force", () => {
  const dir = tempExtensionsDir();
  const targetDir = join(dir, "pi-remote-bridge");
  mkdirSync(targetDir);
  writeFileSync(join(targetDir, "index.ts"), "// someone else's file\n");

  const refused = run(["--dir", dir]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /不是 pi-remote 桥接扩展/);
  assert.equal(readFileSync(join(targetDir, "index.ts"), "utf-8"), "// someone else's file\n");

  const forced = run(["--dir", dir, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(readFileSync(join(targetDir, "index.ts"), "utf-8"), /pi-remote terminal bridge extension/);
});

test("install-terminal-bridge: refuses a symlinked target directory", () => {
  const dir = tempExtensionsDir();
  const real = join(dir, "real-target");
  mkdirSync(real);
  symlinkSync(real, join(dir, "pi-remote-bridge"));

  const result = run(["--dir", dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /符号链接/);
});

test("install-terminal-bridge: runtime targets use isolated agent directories", () => {
  const home = tempExtensionsDir();
  const piAgent = join(home, "custom-pi");
  const ompAgent = join(home, "custom-omp");
  const env = { HOME: home, PI_AGENT_DIR: piAgent, OMP_AGENT_DIR: ompAgent };
  const target = (agent: string) => join(agent, "extensions", "pi-remote-bridge", "index.ts");

  assert.equal(run([], env).status, 0);
  assert.equal(existsSync(target(piAgent)), true);
  assert.equal(existsSync(target(ompAgent)), false);
  assert.equal(run(["--runtime", "omp"], env).status, 0);
  assert.equal(existsSync(target(ompAgent)), true);

  const otherHome = tempExtensionsDir();
  const allEnv = { HOME: otherHome };
  const dry = run(["--runtime", "all", "--dry-run"], allEnv);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal((dry.stdout.match(/\[DRY-RUN\] 将安装扩展/g) ?? []).length, 2);
  assert.equal(existsSync(join(otherHome, ".pi")), false);
  assert.equal(existsSync(join(otherHome, ".omp")), false);
  assert.equal(run(["--runtime", "all"], allEnv).status, 0);
  assert.equal(existsSync(target(join(otherHome, ".pi", "agent"))), true);
  assert.equal(existsSync(target(join(otherHome, ".omp", "agent"))), true);

  assert.notEqual(run(["--runtime", "unknown"], env).status, 0);
  assert.notEqual(run(["--runtime", "all", "--dir", join(home, "extensions")], env).status, 0);
});

test("install-terminal-bridge: all validates both destinations before writing either", () => {
  const home = tempExtensionsDir();
  const foreign = join(home, ".omp", "agent", "extensions", "pi-remote-bridge");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "index.ts"), "// foreign\n");
  const result = run(["--runtime", "all"], { HOME: home });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(home, ".pi", "agent", "extensions")), false);
});
