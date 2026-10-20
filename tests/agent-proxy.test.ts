import assert from "node:assert/strict";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import test from "node:test";
import { proxyAgentFor } from "../src/agent/proxy.ts";

function listen(server: import("node:net").Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port));
  });
}

test("tunnels a WebSocket target through an HTTP CONNECT proxy", async () => {
  const target = createHttpServer((_request, response) => response.end("through-proxy"));
  const targetPort = await listen(target);
  const proxy = createNetServer(socket => {
    socket.once("data", chunk => {
      assert.match(chunk.toString(), /^CONNECT relay\.test:80 /);
      const upstream = netConnect(targetPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
    });
  });
  const proxyPort = await listen(proxy);
  try {
    const agent = proxyAgentFor(new URL("ws://relay.test/ws/agent"), {
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    assert.ok(agent);
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpGet({ host: "relay.test", port: 80, path: "/", agent }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve(text));
      });
      request.on("error", reject);
    });
    assert.equal(body, "through-proxy");
  } finally {
    proxy.close();
    target.close();
  }
});

test("skips loopback, NO_PROXY matches, and missing proxy settings", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:7897" };
  assert.equal(proxyAgentFor(new URL("wss://127.0.0.1:8787/ws/agent"), env), undefined);
  assert.ok(proxyAgentFor(new URL("wss://relay.test/ws/agent"), env));
  assert.equal(proxyAgentFor(new URL("wss://relay.test/ws/agent"), {
    HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "relay.test",
  }), undefined);
  assert.equal(proxyAgentFor(new URL("wss://relay.test/ws/agent"), {}), undefined);
});
