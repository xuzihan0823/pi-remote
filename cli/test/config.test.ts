import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, relayURL, saveConfig, validateConfig } from "../src/config.ts";

test("配置保存后凭据不变，目录和文件保持私有", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cli-config-"));
  try {
    const file = join(directory, "private", "config.json"), config = defaultConfig();
    assert.notEqual(config.pi.token, config.claude.token);
    assert.equal(await loadConfig(file), null);
    await saveConfig(file, config);
    assert.equal((await lstat(join(directory, "private"))).mode & 0o777, 0o700);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await loadConfig(file), config);
    await saveConfig(file, { ...config, service: "pi" });
    assert.equal((await loadConfig(file))?.pi.token, config.pi.token);
    await chmod(file, 0o644);
    await assert.rejects(loadConfig(file), /权限/);
    await assert.rejects(saveConfig(file, config), /权限/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("拒绝符号链接，不覆盖链接目标", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cli-link-"));
  try {
    const file = join(directory, "config.json"), target = join(directory, "target");
    await writeFile(target, "keep", { mode: 0o600 });
    await symlink(target, file);
    await assert.rejects(loadConfig(file));
    await assert.rejects(saveConfig(file, defaultConfig()));
    assert.equal(await readFile(target, "utf8"), "keep");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("拒绝错误配置和敏感 Relay URL", () => {
  for (const url of ["https://example.com/ws/agent", "ws://example.com/ws/agent", "wss://u:password@example.com/ws/agent", "wss://example.com/ws/agent?token=secret", "wss://example.com/ws/ios", "wss://example.com/ws/agent#fragment"]) assert.throws(() => relayURL(url));
  assert.equal(relayURL("wss://example.com/ws/agent").hostname, "example.com");
  assert.equal(relayURL("ws://127.0.0.1:8789/ws/agent").port, "8789");
  const config = defaultConfig();
  assert.throws(() => validateConfig({ ...config, version: 2 }));
  assert.throws(() => validateConfig({ ...config, pi: { ...config.pi, token: "short" } }));
  assert.throws(() => validateConfig({ ...config, pi: { ...config.pi, workspace: "/" } }));
  assert.throws(() => validateConfig({ ...config, claude: { ...config.claude, port: config.pi.port } }));
});
