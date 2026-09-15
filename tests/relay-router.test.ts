import assert from "node:assert/strict";
import test from "node:test";
import type { RelayFrame, RelayRequestFrame, RelayResponseFrame, RelayRole } from "../src/protocol/relay-types.ts";
import { SessionRouter, type RelayPeer } from "../src/relay/session-router.ts";

class FakePeer implements RelayPeer {
  readonly received: RelayFrame[] = [];
  readonly deviceId: string;
  readonly role: RelayRole;

  constructor(deviceId: string, role: RelayRole) {
    this.deviceId = deviceId;
    this.role = role;
  }

  send(frame: RelayFrame): void {
    this.received.push(frame);
  }
}

type ResponseFrame = Extract<RelayFrame, { type: "response" }>;

function findResponse(peer: FakePeer, requestId: string): ResponseFrame | undefined {
  return peer.received.find(
    (frame): frame is ResponseFrame => frame.type === "response" && frame.requestId === requestId,
  );
}

function sessionEvents(peer: FakePeer): Extract<RelayFrame, { type: "session_event" }>[] {
  return peer.received.filter(
    (frame): frame is Extract<RelayFrame, { type: "session_event" }> => frame.type === "session_event",
  );
}

function request(
  requestId: string,
  method: RelayRequestFrame["payload"]["method"],
  options: { sessionId?: string; params?: Record<string, unknown> } = {},
): RelayRequestFrame {
  const frame: RelayRequestFrame = {
    version: 1,
    type: "request",
    requestId,
    payload: options.params ? { method, params: options.params } : { method },
  };
  if (options.sessionId) frame.sessionId = options.sessionId;
  return frame;
}

function agentResponse(requestId: string, payload: RelayResponseFrame["payload"], sessionId?: string): RelayResponseFrame {
  const frame: RelayResponseFrame = { version: 1, type: "response", requestId, payload };
  if (sessionId) frame.sessionId = sessionId;
  return frame;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("routes an iOS request to the agent and returns the agent response with the same requestId", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.list"));

  assert.equal(agent.received.length, 1);
  const forwarded = agent.received[0]!;
  assert.equal(forwarded.type, "request");
  assert.equal(forwarded.requestId, "r1");
  assert.equal(forwarded.deviceId, "iphone-1");
  assert.equal(router.pendingRequestCount(), 1);

  router.handleFrame(agent, agentResponse("r1", { ok: true, data: { sessions: [] } }));

  const response = findResponse(ios, "r1");
  assert.equal(response?.payload.ok, true);
  assert.deepEqual(response?.payload.data, { sessions: [] });
  assert.equal(router.pendingRequestCount(), 0);
});

test("returns a structured error when no agent is connected", () => {
  const router = new SessionRouter();
  const ios = new FakePeer("iphone-1", "ios");
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.list"));

  const response = findResponse(ios, "r1");
  assert.equal(response?.payload.ok, false);
  assert.equal(response?.payload.error?.code, "no_agent_connected");
});

test("subscribe and unsubscribe control which iOS clients receive session events", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  const other = new FakePeer("iphone-2", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);
  router.attachIos(other);

  router.handleFrame(ios, request("s1", "subscribe", { sessionId: "sess-1" }));
  assert.equal(findResponse(ios, "s1")?.payload.ok, true);
  assert.equal(router.subscriberCount("sess-1"), 1);

  router.handleFrame(agent, { version: 1, type: "session_event", sessionId: "sess-1", payload: { event: { type: "text_delta", text: "hi" } } });
  assert.equal(sessionEvents(ios).length, 1);
  assert.equal(sessionEvents(other).length, 0);

  router.handleFrame(ios, request("u1", "unsubscribe", { sessionId: "sess-1" }));
  assert.equal(router.subscriberCount("sess-1"), 0);

  router.handleFrame(agent, { version: 1, type: "session_event", sessionId: "sess-1", payload: { event: { type: "text_delta", text: "again" } } });
  assert.equal(sessionEvents(ios).length, 1);
});

test("a wildcard subscribe receives events for every session", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("s1", "subscribe"));
  assert.equal(router.allSubscriberCount(), 1);

  router.handleFrame(agent, { version: 1, type: "session_event", sessionId: "any-session", payload: { event: { type: "agent_start" } } });
  assert.equal(sessionEvents(ios).length, 1);
});

test("a routed request that never gets a response fails with a timeout error", async () => {
  const router = new SessionRouter({ requestTimeoutMs: 10 });
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.prompt", { sessionId: "sess-1", params: { message: "hello" } }));
  assert.equal(router.pendingRequestCount(), 1);

  await delay(40);

  const response = findResponse(ios, "r1");
  assert.equal(response?.payload.ok, false);
  assert.equal(response?.payload.error?.code, "timeout");
  assert.equal(router.pendingRequestCount(), 0);
});

test("agent disconnect fails in-flight requests and notifies iOS clients", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.prompt", { sessionId: "sess-1", params: { message: "hello" } }));
  router.detachAgent(agent);

  const response = findResponse(ios, "r1");
  assert.equal(response?.payload.ok, false);
  assert.equal(response?.payload.error?.code, "agent_disconnected");
  assert.ok(ios.received.some((frame) => frame.type === "error" && frame.payload.code === "agent_disconnected"));
  assert.equal(router.hasAgent(), false);
});

test("rejects a duplicate in-flight requestId", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.list"));
  router.handleFrame(ios, request("r1", "session.list"));

  assert.equal(agent.received.length, 1);
  const response = findResponse(ios, "r1");
  assert.equal(response?.payload.ok, false);
  assert.equal(response?.payload.error?.code, "duplicate_request_id");
  router.close();
});

test("rejects a routed request with missing params before touching the agent", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.prompt", { params: { message: "no session" } }));

  assert.equal(agent.received.length, 0);
  const response = findResponse(ios, "r1");
  assert.equal(response?.payload.error?.code, "invalid_frame");
});

test("a successful session.start response auto-subscribes the requesting iOS client", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", "session.start"));
  router.handleFrame(agent, agentResponse("r1", { ok: true, data: { sessionId: "sess-9" } }, "sess-9"));

  assert.equal(router.subscriberCount("sess-9"), 1);
  const response = findResponse(ios, "r1");
  assert.equal(response?.sessionId, "sess-9");

  router.handleFrame(agent, { version: 1, type: "session_event", sessionId: "sess-9", payload: { event: { type: "agent_start" } } });
  assert.equal(sessionEvents(ios).length, 1);
});

test("iOS frames in the agent direction are rejected with a structured error", () => {
  const router = new SessionRouter();
  const ios = new FakePeer("iphone-1", "ios");
  router.attachIos(ios);

  router.handleFrame(ios, { version: 1, type: "session_event", sessionId: "sess-1", payload: { event: {} } });

  assert.ok(ios.received.some((frame) => frame.type === "error" && frame.payload.code === "invalid_frame"));
});
