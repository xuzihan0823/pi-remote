import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundEnvironment, systemHttpsProxy } from "../src/background/environment.ts";

const system = "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 1082\n}";

test("background OMP inherits the enabled macOS proxy, without disabling TLS checks", async () => {
  const env = await backgroundEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0", BUN_TLS_REJECT_UNAUTHORIZED: "0", NODE_OPTIONS: "--require unwanted" }, "darwin", async () => system);
  assert.equal(env.PI_PROXY, "http://127.0.0.1:1082");
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.BUN_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("explicit network configuration wins over system proxy and keeps provider overrides, exclusions and trusted CA", async () => {
  const readProxy = async (): Promise<string> => { throw new Error("must not query system configuration"); };
  const source = { HTTPS_PROXY: "http://127.0.0.1:9000", PI_PROXY_GOOGLE_ANTIGRAVITY: "http://127.0.0.1:9001", NO_PROXY: "localhost,127.0.0.1", NODE_EXTRA_CA_CERTS: "/trusted/ca.pem", PI_REMOTE_SUPERVISOR_PID: "1234" };
  const env = await backgroundEnvironment(source, "darwin", readProxy);
  assert.equal(env.PI_PROXY, source.HTTPS_PROXY);
  for (const [key, value] of Object.entries(source)) assert.equal(env[key], value);
  assert.equal((await backgroundEnvironment({ ...source, PI_PROXY: "http://127.0.0.1:9002" }, "darwin", readProxy)).PI_PROXY, "http://127.0.0.1:9002");
});

test("disabled, invalid or unavailable macOS proxy does not invent a route; other platforms never invoke scutil", async () => {
  for (const output of ["", system.replace("HTTPSEnable : 1", "HTTPSEnable : 0"), system.replace("1082", "65536"), system.replace("127.0.0.1", "bad/host")]) {
    assert.equal(systemHttpsProxy(output), undefined);
  }
  assert.equal(systemHttpsProxy("HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 8080"), "http://[::1]:8080");
  assert.equal((await backgroundEnvironment({}, "darwin", async () => { throw new Error("not available"); })).PI_PROXY, undefined);
  let calls = 0;
  assert.equal((await backgroundEnvironment({}, "linux", async () => { calls++; return system; })).PI_PROXY, undefined);
  assert.equal(calls, 0);
});
