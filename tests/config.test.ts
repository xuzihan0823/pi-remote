import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigError,
  DEFAULT_AGENT_DEVICE_ID,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  MAX_AGENT_DEVICE_ID_LENGTH,
  describeConfig,
  loadConfig,
} from "../src/config.ts";

const TOKEN = "a".repeat(32);
const BASE = { RELAY_TOKEN: TOKEN };

test("loadConfig requires a relay token", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ RELAY_TOKEN: "   " }), ConfigError);
  assert.throws(() => loadConfig({ RELAY_TOKEN: "too-short" }), ConfigError);
});

test("loadConfig applies documented defaults", () => {
  assert.deepEqual(loadConfig(BASE), {
    relayHost: DEFAULT_RELAY_HOST,
    relayPort: DEFAULT_RELAY_PORT,
    relayToken: TOKEN,
    relayUrl: `ws://${DEFAULT_RELAY_HOST}:${DEFAULT_RELAY_PORT}/ws/agent`,
    agentToken: TOKEN,
    agentDeviceId: DEFAULT_AGENT_DEVICE_ID,
    piBin: "pi",
    piWorkspaceRoot: join(homedir(), "Desktop"),
    maxSessions: DEFAULT_MAX_SESSIONS,
  });
});

test("loadConfig reads overrides and trims values", () => {
  const config = loadConfig({
    RELAY_HOST: " 0.0.0.0 ",
    RELAY_PORT: "9001",
    RELAY_TOKEN: `  ${TOKEN}  `,
    PI_BIN: " /opt/pi/bin/pi ",
    PI_WORKSPACE_ROOT: " /srv/workspaces ",
    MAX_SESSIONS: "4",
  });
  assert.deepEqual(config, {
    relayHost: "0.0.0.0",
    relayPort: 9001,
    relayToken: TOKEN,
    relayUrl: "ws://0.0.0.0:9001/ws/agent",
    agentToken: TOKEN,
    agentDeviceId: DEFAULT_AGENT_DEVICE_ID,
    piBin: "/opt/pi/bin/pi",
    piWorkspaceRoot: "/srv/workspaces",
    maxSessions: 4,
  });
});

test("loadConfig reads agent-specific overrides", () => {
  const agentToken = "b".repeat(32);
  const config = loadConfig({
    ...BASE,
    RELAY_URL: " wss://relay.example.com/ws/agent ",
    AGENT_TOKEN: ` ${agentToken} `,
    AGENT_DEVICE_ID: " macbook-pro:1 ",
  });
  assert.equal(config.relayUrl, "wss://relay.example.com/ws/agent");
  assert.equal(config.agentToken, agentToken);
  assert.equal(config.agentDeviceId, "macbook-pro:1");
});

test("loadConfig rejects an invalid RELAY_URL", () => {
  for (const url of ["http://relay.example.com", "not a url", `ws://relay.example.com/ws/agent?token=${TOKEN}`]) {
    assert.throws(() => loadConfig({ ...BASE, RELAY_URL: url }), ConfigError, `expected ${JSON.stringify(url)} to be rejected`);
  }
});

test("loadConfig validates AGENT_TOKEN", () => {
  assert.throws(() => loadConfig({ ...BASE, AGENT_TOKEN: "too-short" }), ConfigError);
  assert.equal(loadConfig({ ...BASE, AGENT_TOKEN: "   " }).agentToken, TOKEN);
});

test("loadConfig validates AGENT_DEVICE_ID and defaults it when empty", () => {
  assert.equal(loadConfig({ ...BASE, AGENT_DEVICE_ID: "   " }).agentDeviceId, DEFAULT_AGENT_DEVICE_ID);
  assert.equal(loadConfig({ ...BASE, AGENT_DEVICE_ID: "mac_1:agent" }).agentDeviceId, "mac_1:agent");
  for (const deviceId of ["-leading", "has space", "a/b", "x".repeat(MAX_AGENT_DEVICE_ID_LENGTH + 1)]) {
    assert.throws(() => loadConfig({ ...BASE, AGENT_DEVICE_ID: deviceId }), ConfigError, `expected ${JSON.stringify(deviceId)} to be rejected`);
  }
});

test("describeConfig never includes a token", () => {
  const agentToken = "b".repeat(32);
  const summary = describeConfig(loadConfig({ ...BASE, RELAY_TOKEN: TOKEN, AGENT_TOKEN: agentToken }));
  assert.equal(summary.includes(TOKEN), false);
  assert.equal(summary.includes(agentToken), false);
  assert.match(summary, /agentDeviceId=pi-mac-agent/);
});

test("loadConfig rejects invalid hosts", () => {
  for (const host of ["", "   ", "http://localhost", "127.0.0.1:8789", "has space"]) {
    assert.throws(() => loadConfig({ ...BASE, RELAY_HOST: host }), ConfigError, `expected ${JSON.stringify(host)} to be rejected`);
  }
});

test("loadConfig rejects invalid ports", () => {
  for (const port of ["0", "65536", "-1", "abc", "1.5", ""]) {
    assert.throws(() => loadConfig({ ...BASE, RELAY_PORT: port }), ConfigError, `expected ${JSON.stringify(port)} to be rejected`);
  }
});

test("loadConfig rejects an empty PI_BIN", () => {
  assert.throws(() => loadConfig({ ...BASE, PI_BIN: "   " }), ConfigError);
});

test("loadConfig requires an absolute, non-root workspace root", () => {
  assert.throws(() => loadConfig({ ...BASE, PI_WORKSPACE_ROOT: "relative/dir" }), ConfigError);
  assert.throws(() => loadConfig({ ...BASE, PI_WORKSPACE_ROOT: "/" }), ConfigError);
});

test("loadConfig bounds MAX_SESSIONS", () => {
  for (const max of ["0", "129", "-1", "abc"]) {
    assert.throws(() => loadConfig({ ...BASE, MAX_SESSIONS: max }), ConfigError, `expected ${JSON.stringify(max)} to be rejected`);
  }
});
