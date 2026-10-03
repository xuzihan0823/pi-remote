import assert from "node:assert/strict";
import test from "node:test";
import {
  RELAY_REQUEST_METHODS,
  isRequestMethod,
  parseRelayFrame,
  type RelayFrame,
  type RelayRequestFrame,
  type RelayResponseFrame,
  type RelayRole,
} from "../src/protocol/relay-types.ts";
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

function request(requestId: string, options: { sessionId?: string } = {}): RelayRequestFrame {
  const frame: RelayRequestFrame = {
    version: 1,
    type: "request",
    requestId,
    payload: { method: "session.get" },
  };
  if (options.sessionId) frame.sessionId = options.sessionId;
  return frame;
}

function findResponse(peer: FakePeer, requestId: string): Extract<RelayFrame, { type: "response" }> | undefined {
  return peer.received.find(
    (frame): frame is Extract<RelayFrame, { type: "response" }> => frame.type === "response" && frame.requestId === requestId,
  );
}

test("session.get is part of the wire protocol and parses", () => {
  assert.ok(RELAY_REQUEST_METHODS.includes("session.get"));
  assert.equal(isRequestMethod("session.get"), true);

  const parsed = parseRelayFrame({
    version: 1,
    type: "request",
    requestId: "r1",
    sessionId: "terminal:abc",
    payload: { method: "session.get" },
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.frame.type, "request");
    assert.equal((parsed.frame as RelayRequestFrame).sessionId, "terminal:abc");
  }
});

test("session.get without a sessionId is rejected before reaching the agent", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1"));

  assert.equal(agent.received.length, 0);
  assert.equal(findResponse(ios, "r1")?.payload.error?.code, "invalid_frame");
});

test("session.get is forwarded with its sessionId and its response is routed back", () => {
  const router = new SessionRouter();
  const agent = new FakePeer("mac-1", "agent");
  const ios = new FakePeer("iphone-1", "ios");
  router.attachAgent(agent);
  router.attachIos(ios);

  router.handleFrame(ios, request("r1", { sessionId: "terminal:abc" }));

  assert.equal(agent.received.length, 1);
  const forwarded = agent.received[0] as RelayRequestFrame;
  assert.equal(forwarded.sessionId, "terminal:abc");
  assert.equal(forwarded.deviceId, "iphone-1");

  const response: RelayResponseFrame = {
    version: 1,
    type: "response",
    requestId: "r1",
    sessionId: "terminal:abc",
    payload: { ok: true, data: { sessionId: "terminal:abc", activity: "idle", messages: [], truncated: false } },
  };
  router.handleFrame(agent, response);

  assert.deepEqual(findResponse(ios, "r1")?.payload.data, {
    sessionId: "terminal:abc",
    activity: "idle",
    messages: [],
    truncated: false,
  });
});
