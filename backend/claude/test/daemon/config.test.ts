// 独立后端配置契约测试：token 强度/原始 env 校验、state 根路径、instanceId、
// public bases 净化。全部走 loadConfig/stateRoot，不读写用户 ~/.claude。

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, loadConfig, stateRoot } from "../../src/config.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("token：缺省/过短/含空白一律拒启，且错误信息不回显 token", () => {
  for (const env of [{}, { BRIDGE_TOKEN: "" }, { BRIDGE_TOKEN: "short" }, { BRIDGE_TOKEN: TOKEN.slice(0, 31) }]) {
    assert.throws(() => loadConfig(env), ConfigError);
  }
  // 原始 env 校验：trim 不得把空白洗掉
  for (const raw of [` ${TOKEN} `, `${TOKEN}\n`, `\t${TOKEN}`, `${TOKEN.slice(0, 40)} ${"x".repeat(5)}`]) {
    try {
      loadConfig({ BRIDGE_TOKEN: raw });
      assert.fail("应因空白拒启");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes(TOKEN), false, "错误信息不得包含 token");
    }
  }
  assert.equal(loadConfig({ BRIDGE_TOKEN: TOKEN }).token, TOKEN);
});

test("默认端口 8788，可覆盖且校验范围", () => {
  assert.equal(loadConfig({ BRIDGE_TOKEN: TOKEN }).port, 8788);
  assert.equal(loadConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: "9001" }).port, 9001);
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: "0" }), ConfigError);
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: "70000" }), ConfigError);
});

test("state 根：macOS 用 Application Support，其他平台遵循 XDG", () => {
  assert.equal(stateRoot({}, "darwin"), join(homedir(), "Library", "Application Support", "Pi Remote", "Claude"));
  assert.equal(stateRoot({}, "linux"), join(homedir(), ".local", "share", "pi-remote", "claude"));
  assert.equal(stateRoot({ XDG_STATE_HOME: "/custom/state" }, "linux"), "/custom/state/pi-remote/claude");
  assert.equal(stateRoot({ XDG_STATE_HOME: "relative" }, "linux"), join(homedir(), ".local", "share", "pi-remote", "claude"));
});

test("默认 db/uploads 落在 state 根，不依赖 cwd；相对覆盖锚定 state 根", () => {
  const base = stateRoot({});
  const config = loadConfig({ BRIDGE_TOKEN: TOKEN });
  assert.equal(config.interactionsDbPath, join(base, "interactions.sqlite"));
  assert.equal(config.uploadsDir, join(base, "uploads"));

  const relative = loadConfig({ BRIDGE_TOKEN: TOKEN, INTERACTIONS_DB_PATH: "sub/db.sqlite", UPLOADS_DIR: "up" });
  assert.equal(relative.interactionsDbPath, join(base, "sub", "db.sqlite"));
  assert.equal(relative.uploadsDir, join(base, "up"));

  const memory = loadConfig({ BRIDGE_TOKEN: TOKEN, INTERACTIONS_DB_PATH: ":memory:" });
  assert.equal(memory.interactionsDbPath, ":memory:");
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: TOKEN, UPLOADS_DIR: "bad\0path" }), ConfigError);
});

test("instanceId：默认随机 UUID；显式值必须严格 UUID", () => {
  const generated = loadConfig({ BRIDGE_TOKEN: TOKEN }).instanceId;
  assert.match(String(generated), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(
    loadConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_INSTANCE_ID: "11111111-2222-4333-8444-555555555555" }).instanceId,
    "11111111-2222-4333-8444-555555555555",
  );
  assert.equal(
    loadConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_INSTANCE_ID: "ABCDEF01-2222-4333-8444-555555555555" }).instanceId,
    "ABCDEF01-2222-4333-8444-555555555555",
  );
  assert.throws(() => loadConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_INSTANCE_ID: "not-a-uuid" }), ConfigError);
});

test("BRIDGE_PUBLIC_BASES：保留协议、去掉 userinfo/非法项、去重", () => {
  const bases = loadConfig({
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_PUBLIC_BASES: " https://a.example.com/ ,http://b:1 ,bad,ftp://c,http://u:p@d:9,https://a.example.com ",
  }).publicBases;
  assert.deepEqual(bases, ["https://a.example.com", "http://b:1"]);
});
