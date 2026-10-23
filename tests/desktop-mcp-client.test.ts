import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import nodeTest from "node:test";
import { DesktopConnectionError, DesktopMcpClient } from "../src/desktop/mcp-client.ts";

/**
 * The client refuses connection files whose ancestor directories are group/world writable (the
 * same rule ssh applies). Linux containers and CI often have a 1777 home, so pick a base that
 * passes the rule, or skip the suite instead of failing and leaving servers open.
 */
async function safeBase(): Promise<string | undefined> {
  for (const candidate of [process.env.PI_REMOTE_TEST_SAFE_DIR, homedir(), process.cwd()]) {
    if (!candidate) continue;
    let current: string = sep;
    let ok = true;
    for (const part of ["", ...resolve(candidate).split(sep).filter(Boolean)]) {
      current = part ? resolve(current, part) : current;
      const info = await lstat(current).catch(() => undefined);
      if (!info || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) { ok = false; break; }
    }
    if (ok) return resolve(candidate);
  }
  return undefined;
}
const SAFE_BASE = await safeBase();
const test = SAFE_BASE
  ? nodeTest
  : ((name: string, ..._rest: unknown[]) => nodeTest(name, { skip: "no directory with a non-writable ancestor chain; set PI_REMOTE_TEST_SAFE_DIR" })) as typeof nodeTest;

const TOKEN = "local-secret-token";
const SESSION = "session-test-1";
const PID = process.pid;
type RpcRequest = { jsonrpc: string; id?: string; method: string; params?: Record<string, unknown> };
type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>;

async function listen(handler: Handler, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += Buffer.from(chunk).toString("utf8");
    await handler(request, response, body);
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

async function stop(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function spawnMcpHost(): Promise<{ child: ReturnType<typeof spawn>; port: number }> {
  const child = spawn(process.execPath, ["-e", String.raw`
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => body += chunk);
      request.on('end', () => {
        const rpc = body ? JSON.parse(body) : {};
        if (request.method === 'DELETE') return response.writeHead(204).end();
        if (rpc.method === 'notifications/initialized') return response.writeHead(202).end();
        const result = rpc.method === 'initialize'
          ? {protocolVersion: '2025-06-18', serverInfo: {name: 'pi-desktop'}}
          : {structuredContent: {ok: true}, content: []};
        response.writeHead(200, {'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-child'});
        response.end(JSON.stringify({jsonrpc: '2.0', id: rpc.id, result}));
      });
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + String.fromCharCode(10)));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout! });
  try {
    const portText = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake Desktop startup timed out")), 2_000);
      lines.once("line", line => { clearTimeout(timer); resolve(line); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`fake Desktop exited before ready: ${code}`)); });
    });
    const port = Number(portText);
    assert.ok(Number.isInteger(port) && port > 0);
    lines.close();
    return { child, port };
  } catch (error) {
    lines.close();
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
    throw error;
  }
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

function json(response: ServerResponse, id: string, result: unknown, headers?: Record<string, string>): void {
  response.writeHead(200, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function fixture(): Promise<{
  directory: string;
  file: string;
  set: (port: number, overrides?: Record<string, unknown>) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(SAFE_BASE ?? homedir(), ".pi-desktop-mcp-"));
  await chmod(directory, 0o700);
  const file = join(directory, "mcp-control.json");
  const set = async (port: number, overrides: Record<string, unknown> = {}): Promise<void> => {
    await writeFile(file, JSON.stringify({ active: true, url: `http://127.0.0.1:${port}/mcp`, token: TOKEN, pid: PID, ...overrides }), { mode: 0o600 });
    await chmod(file, 0o600);
  };
  return { directory, file, set, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function client(file: string, options: { timeoutMs?: number; maxResponseBytes?: number } = {}): DesktopMcpClient {
  return new DesktopMcpClient({ connectionFiles: [file], ...options });
}

function assertCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DesktopConnectionError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /secret|hello|timeout/i);
    return true;
  };
}

function createMcp(
  tool: (request: RpcRequest, count: number) => unknown = () => ({ structuredContent: { ok: true }, content: [] }),
  options: { version?: string; delayInitialize?: number; initialize?: () => void; redirectTool?: boolean } = {},
): Promise<{ server: Server; port: number; requests: RpcRequest[]; tools: RpcRequest[]; deletes: number }> {
  const requests: RpcRequest[] = [];
  const tools: RpcRequest[] = [];
  let deletes = 0;
  return listen((request, response, body) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers.accept, "application/json, text/event-stream");
    const rpc = body ? JSON.parse(body) as RpcRequest : undefined;
    if (request.method === "DELETE") {
      deletes++;
      response.writeHead(204).end();
      return;
    }
    assert.ok(rpc);
    requests.push(rpc);
    if (rpc.method === "initialize") {
      options.initialize?.();
      const answer = (): void => json(response, rpc.id!, {
        protocolVersion: options.version ?? "2025-06-18",
        serverInfo: { name: "pi-desktop", version: "test" },
        capabilities: { tools: {} },
      }, { "Mcp-Session-Id": SESSION });
      if (options.delayInitialize) setTimeout(answer, options.delayInitialize);
      else answer();
    } else {
      assert.equal(request.headers["mcp-session-id"], SESSION);
      assert.equal(request.headers["mcp-protocol-version"], options.version ?? "2025-06-18");
      if (rpc.method === "notifications/initialized") response.writeHead(202).end();
      else {
        assert.equal(rpc.method, "tools/call");
        tools.push(rpc);
        if (options.redirectTool) response.writeHead(307, { Location: "http://127.0.0.1/elsewhere" }).end();
        else json(response, rpc.id!, tool(rpc, tools.length));
      }
    }
  }).then(value => ({ ...value, requests, tools, get deletes() { return deletes; } }));
}

test("negotiates MCP, authenticates requests, returns structured content and only deletes its session", async () => {
  const fake = await createMcp(() => ({ structuredContent: { value: 3 }, content: [{ type: "text", text: "ignored" }] }));
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    const instance = client(temp.file);
    assert.deepEqual(await instance.call("pi_desktop_invoke", { operation: "send_prompt", text: "hello" }), { value: 3 });
    const initialize = fake.requests[0]!;
    assert.equal(initialize.method, "initialize");
    assert.equal(typeof initialize.id, "string");
    assert.deepEqual(initialize.params, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-remote", version: "0.1.0" } });
    const toolRequest = fake.tools[0]!;
    assert.deepEqual(toolRequest, {
      jsonrpc: "2.0",
      id: toolRequest.id,
      method: "tools/call",
      params: { name: "pi_desktop_invoke", arguments: { operation: "send_prompt", text: "hello" } },
    });
    assert.ok(fake.requests.every(request => request.jsonrpc === "2.0"));
    assert.deepEqual(fake.requests.map(request => request.method), ["initialize", "notifications/initialized", "tools/call"]);
    await instance.close();
    assert.equal(fake.deletes, 1);
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }
});

test("accepts the older protocol version and coalesces concurrent initialization", async () => {
  let count = 0;
  const fake = await createMcp(undefined, { version: "2025-03-26", delayInitialize: 15, initialize: () => count++ });
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    const instance = client(temp.file);
    assert.deepEqual(await Promise.all([instance.call("one"), instance.call("two")]), [{ ok: true }, { ok: true }]);
    assert.equal(count, 1);
    assert.equal(fake.requests.filter(request => request.method === "notifications/initialized").length, 1);
    await instance.close();
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }
});

test("does not replay expired-session prompts; only the next call initializes a new session", async () => {
  let initializes = 0;
  let tools = 0;
  const fake = await listen((_request, response, body) => {
    const rpc = body ? JSON.parse(body) as RpcRequest : undefined;
    if (rpc?.method === "initialize") {
      initializes++;
      json(response, rpc.id!, { protocolVersion: "2025-06-18", serverInfo: { name: "pi-desktop" } }, { "Mcp-Session-Id": SESSION });
    } else if (rpc?.method === "notifications/initialized") response.writeHead(202).end();
    else if (rpc?.method === "tools/call") { tools++; response.writeHead(404).end(); }
    else response.writeHead(204).end();
  });
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    const instance = client(temp.file);
    await assert.rejects(instance.call("send_prompt", { text: "hello" }), assertCode("session_expired"));
    assert.equal(tools, 1);
    await assert.rejects(instance.call("send_prompt"), assertCode("session_expired"));
    assert.equal(tools, 2);
    assert.equal(initializes, 2);
    await instance.close();
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }
});

test("rejects untrusted endpoints, credentials, query/fragment, symlinks and unsafe modes", async () => {
  const fake = await createMcp();
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    const instance = client(temp.file);
    for (const url of [
      `http://localhost:${fake.port}/mcp`, `http://127.0.0.2:${fake.port}/mcp`, `http://[::1]:${fake.port}/mcp`,
      `http://127.0.0.1:${fake.port}/mcp?token=x`, `http://user:pass@127.0.0.1:${fake.port}/mcp`,
      `http://127.0.0.1:${fake.port}/mcp#frag`,
    ]) {
      await temp.set(fake.port, { url });
      await assert.rejects(instance.call("read"), assertCode("not_connected"));
    }
    await temp.set(fake.port);
    await chmod(temp.file, 0o644);
    await assert.rejects(instance.call("read"), assertCode("not_connected"));
    await chmod(temp.file, 0o600);
    const link = join(temp.directory, "link.json");
    await symlink(temp.file, link);
    const linked = client(link);
    await assert.rejects(linked.call("read"), assertCode("not_connected"));
    const unsafeDir = join(temp.directory, "unsafe");
    await mkdir(unsafeDir, { mode: 0o777 });
    await chmod(unsafeDir, 0o777);
    const unsafeFile = join(unsafeDir, "mcp-control.json");
    await writeFile(unsafeFile, JSON.stringify({ active: true, url: `http://127.0.0.1:${fake.port}/mcp`, token: TOKEN, pid: PID }), { mode: 0o600 });
    await assert.rejects(client(unsafeFile).call("read"), assertCode("not_connected"));
    assert.equal(fake.requests.length, 0);
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }
});

test("rejects error, nested failure, truncated envelopes and redirect without leaking details", async () => {
  const answers: unknown[] = [
    { structuredContent: { ok: false, message: "private" }, content: [] },
    { structuredContent: {}, content: [], isError: true },
    { structuredContent: { ok: true } },
    { content: [] },
    { structuredContent: { truncated: true, reason: "MCP_RESULT_LIMIT", preview: "private-preview" }, content: [] },
    { structuredContent: { operation: "get", result: { truncated: true, reason: "MCP_RESULT_LIMIT", preview: "wrapped-private-preview" } }, content: [] },
    { structuredContent: { operation: "get", result: { truncated: true, reason: "MCP_RESULT_LIMIT", preview: "wrapped-private-preview" } }, content: [] },
    { structuredContent: { ok: false, operation: "prompt", result: { truncated: true, reason: "MCP_RESULT_LIMIT", preview: "mutation-preview" } }, content: [] },
  ];
  const fake = await createMcp((_request, count) => answers[count - 1]);
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    const instance = client(temp.file);
    await assert.rejects(instance.call("write"), assertCode("tool_error"));
    await assert.rejects(instance.call("write"), assertCode("tool_error"));
    await assert.rejects(instance.call("write"), assertCode("result_uncertain"));
    await assert.rejects(instance.call("write"), assertCode("result_uncertain"));
    await assert.rejects(instance.call("pi_session_get"), error => {
      assert.ok(error instanceof DesktopConnectionError);
      assert.equal(error.code, "result_too_large");
      assert.ok(!error.message.includes("private-preview"));
      return true;
    });
    assert.equal(fake.tools.length, 5);
    await assert.rejects(instance.call("pi_agent_prompt"), error => {
      assert.ok(error instanceof DesktopConnectionError);
      assert.equal(error.code, "result_too_large");
      assert.ok(!error.message.includes("wrapped-private-preview"));
      return true;
    });
    assert.equal(fake.tools.length, 6);
    await assert.rejects(instance.call("pi_agent_prompt"), error => {
      assert.ok(error instanceof DesktopConnectionError);
      assert.equal(error.code, "result_too_large");
      assert.ok(!error.message.includes("mutation-preview"));
      return true;
    });
    assert.equal(fake.tools.length, 7);
    await instance.close();
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }

  const redirect = await createMcp(undefined, { redirectTool: true });
  const redirectFixture = await fixture();
  try {
    await redirectFixture.set(redirect.port);
    await assert.rejects(client(redirectFixture.file).call("write"), assertCode("result_uncertain"));
  } finally {
    await stop(redirect.server);
    await redirectFixture.cleanup();
  }
});

test("does not treat failure-shaped user data in a session as a tool error", async () => {
  const data = { id: "session-1", messages: [
    { toolArgs: { ok: false }, toolResult: { ok: false }, content: { truncated: true, reason: "MCP_RESULT_LIMIT", preview: "user-content" } },
  ] };
  const fake = await createMcp(() => ({ structuredContent: data, content: [] }));
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    assert.deepEqual(await client(temp.file).call("pi_session_get"), data);
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }
});

test("bounds response size and request time without retrying the tool", async () => {
  const fake = await createMcp(() => ({ structuredContent: { result: "x".repeat(4096) }, content: [] }));
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    const instance = client(temp.file, { maxResponseBytes: 512 });
    await assert.rejects(instance.call("read"), assertCode("result_uncertain"));
    assert.equal(fake.tools.length, 1);
    await instance.close();
  } finally {
    await stop(fake.server);
    await temp.cleanup();
  }

  const slow = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
  });
  const slowFixture = await fixture();
  try {
    await slowFixture.set(slow.port);
    await assert.rejects(client(slowFixture.file, { timeoutMs: 25 }).call("write"), assertCode("not_connected"));
  } finally {
    await stop(slow.server);
    await slowFixture.cleanup();
  }
});

test("invalidates the session on atomic connection-file replacement", async () => {
  const old = await createMcp(() => ({ structuredContent: { name: "old" }, content: [] }));
  const current = await createMcp(() => ({ structuredContent: { name: "current" }, content: [] }));
  const temp = await fixture();
  try {
    await temp.set(old.port);
    const instance = client(temp.file);
    assert.deepEqual(await instance.call("read"), { name: "old" });
    const next = join(temp.directory, "next.json");
    await writeFile(next, JSON.stringify({ active: true, url: `http://127.0.0.1:${current.port}/mcp`, token: TOKEN, pid: PID }), { mode: 0o600 });
    await chmod(next, 0o600);
    await rename(next, temp.file);
    assert.deepEqual(await instance.call("read"), { name: "current" });
    assert.equal(old.tools.length, 1);
    assert.equal(current.requests.filter(request => request.method === "initialize").length, 1);
    await instance.close();
    assert.equal(current.deletes, 1);
  } finally {
    await stop(old.server);
    await stop(current.server);
    await temp.cleanup();
  }
});

test("does not send cached credentials to a process that reuses Desktop's port", async () => {
  const victim = await spawnMcpHost();
  const temp = await fixture();
  let replacement: Server | undefined;
  try {
    await temp.set(victim.port, { pid: victim.child.pid });
    const instance = client(temp.file);
    assert.deepEqual(await instance.call("read"), { ok: true });
    await stopChild(victim.child);

    const seenAuthorization: string[] = [];
    replacement = (await listen(request => {
      seenAuthorization.push(String(request.headers.authorization ?? ""));
    }, victim.port)).server;
    await instance.close();
    assert.deepEqual(seenAuthorization, [], "close must not send cached bearer to a listener reusing the port");
  } finally {
    await stopChild(victim.child);
    if (replacement) await stop(replacement);
    await temp.cleanup();
  }
});

test("skips failed-initialize cleanup after the connection changes", async () => {
  let deletes = 0;
  let initializeStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { initializeStarted = resolve; });
  let instance: DesktopMcpClient | undefined;
  const fake = await listen(async (request, response, body) => {
    const rpc = body ? JSON.parse(body) as RpcRequest : undefined;
    if (request.method === "DELETE") { deletes++; response.writeHead(204).end(); }
    else if (rpc?.method === "initialize") {
      initializeStarted?.();
      response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": SESSION });
      response.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "pi-desktop" } } }));
      await new Promise(resolve => setTimeout(resolve, 40));
      response.end();
    }
  });
  const temp = await fixture();
  try {
    await temp.set(fake.port);
    instance = client(temp.file);
    const failed = instance.call("read");
    await started;
    const replacement = join(temp.directory, "replacement.json");
    await writeFile(replacement, JSON.stringify({ active: true, url: `http://127.0.0.1:${fake.port}/mcp`, token: "replacement-secret", pid: PID }), { mode: 0o600 });
    await chmod(replacement, 0o600);
    await rename(replacement, temp.file);
    await assert.rejects(failed, assertCode("not_connected"));
    assert.equal(deletes, 0, "the successful initialize response was invalidated before notification/commit; no cached bearer is sent");
  } finally {
    await instance?.close();
    await stop(fake.server);
    await temp.cleanup();
  }
});

test("connection errors never reveal tokens", async () => {
  const temp = await fixture();
  try {
    await temp.set(1);
    await assert.rejects(client(temp.file).call("read"), error => {
      assert.ok(error instanceof DesktopConnectionError);
      assert.equal(error.code, "not_connected");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
  } finally {
    await temp.cleanup();
  }
});
