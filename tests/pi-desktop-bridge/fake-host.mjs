// 测试用的假 PI-Desktop 宿主：模拟全局 pi 对象里插件用到的部分（desktop / net.websocket / events / plugin）。
// desktop.invoke 的参数形态与 apps/desktop/electron/main/mcp-control.ts、ipc/*.ts 的处理器一致。

export const CATALOG = [
  { id: "session/list", risk: "read" },
  { id: "session/get", risk: "read" },
  { id: "session/create", risk: "write" },
  { id: "session/configure", risk: "dangerous" },
  { id: "session/delete", risk: "dangerous" },
  { id: "agent/prompt", risk: "write" },
  { id: "agent/abort", risk: "write" },
  { id: "agent/getStatus", risk: "read" },
  { id: "providers/list", risk: "read" },
  { id: "providers/listModels", risk: "read" },
  { id: "project/list", risk: "read" },
  { id: "plans/pending", risk: "read" },
  { id: "plans/resolve", risk: "dangerous" },
  { id: "tool/resolvePermission", risk: "dangerous" },
  { id: "agent/askTool/resolve", risk: "dangerous" },
];

export function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: "2026-10-23T00:00:00Z", ...extra };
}

/** 一个最小的 PI-Desktop 数据集。 */
export function createDesktopStore() {
  const store = {
    sessions: [
      {
        id: "s1", title: "修复登录", source: "desktop", projectPath: "/Users/me/app", updatedAt: "2026-10-23T08:00:00Z",
        createdAt: "2026-10-22T08:00:00Z", providerId: "anthropic", modelId: "claude-sonnet", permissionMode: "auto",
        capabilities: { canPrompt: true, canStop: true }, mode: "agent",
      },
      {
        id: "s2", title: "写文档", source: "desktop", updatedAt: "2026-10-23T09:00:00Z", createdAt: "2026-10-23T07:00:00Z",
        providerId: "openai", modelId: "gpt-5", permissionMode: "ask", capabilities: { canPrompt: true }, mode: "agent",
      },
      { id: "native-pi:abc", title: "CLI 会话", updatedAt: "2026-10-23T10:00:00Z" },
      { id: "r1", title: "远程主机", source: "desktop", remoteHostKey: "host-1", updatedAt: "2026-10-23T10:00:00Z" },
      { id: "sched1", title: "定时任务", source: "desktop", scheduledRun: true, updatedAt: "2026-10-23T10:00:00Z" },
    ],
    messages: {
      s1: [
        message("m1", "user", "帮我看看登录为什么失败"),
        message("m2", "assistant", "我先读取日志。"),
        message("m3", "tool", "", { toolName: "Read", toolCallId: "call-1", toolStatus: "success", toolArgs: { path: "log.txt", apiKey: "sk-should-hide-0123456789abcdef" }, toolResult: "ERROR token expired" }),
        message("m4", "tool", "", { toolName: "Bash", toolCallId: "call-2", toolStatus: "running", toolArgs: { command: "npm test" } }),
        message("m5", "assistant", "子 agent 的输出", { parentToolCallId: "task-1" }),
        message("m6", "user", "附上截图", { attachments: [{ kind: "image", name: "/tmp/screen shot.png", ref: "att-1" }] }),
      ],
      s2: [message("n1", "user", "hello")],
    },
    status: {
      s1: { sessionId: "s1", isRunning: false, pendingToolConfirmations: 0 },
      s2: { sessionId: "s2", isRunning: false, pendingToolConfirmations: 0 },
    },
    projects: [{ id: 1, path: "/Users/me/app", name: "app" }],
    providers: [
      { id: "anthropic", enabled: true },
      { id: "openai", enabled: true },
      { id: "disabled-one", enabled: false },
    ],
    models: {
      anthropic: [{ modelId: "claude-sonnet", displayName: "Claude Sonnet", contextWindow: 200000 }],
      openai: [{ modelId: "gpt-5", displayName: "GPT-5" }],
    },
    calls: [],
    nextId: 100,
  };
  return store;
}

function sessionGet(store, input) {
  const session = store.sessions.find((candidate) => candidate.id === input.id);
  if (!session) return { session: null };
  const all = store.messages[session.id] ?? [];
  const total = all.length;
  const limit = input.messageLimit ?? total;
  let before;
  if (input.messageAround !== undefined) {
    const position = all.findIndex((candidate) => candidate.id === input.messageAround);
    if (position < 0) return { session: null };
    before = Math.min(position + Math.floor(limit / 2) + 1, total);
  } else {
    before = input.messageBefore === undefined ? total : Math.min(input.messageBefore, total);
  }
  const start = Math.max(0, before - limit);
  const contentLimit = input.contentLimit;
  const messages = all.slice(start, before).map((entry) => (
    contentLimit && typeof entry.content === "string" && entry.content.length > contentLimit
      ? { ...entry, content: entry.content.slice(0, contentLimit) }
      : entry
  ));
  return {
    session: {
      ...session,
      messages,
      messageStart: start,
      messageEnd: before,
      hasMoreBefore: start > 0,
      hasMoreAfter: before < total,
    },
  };
}

export function createDesktopApi(store, catalog = CATALOG) {
  return {
    async listOperations() {
      return catalog.map((entry) => ({ ...entry, description: entry.id }));
    },
    async invoke({ operation, args = [], confirm }) {
      store.calls.push({ operation, args, confirm });
      const entry = catalog.find((candidate) => candidate.id === operation);
      if (!entry) throw Object.assign(new Error(`operation is not exposed: ${operation}`), { code: "NOT_FOUND" });
      if (entry.risk === "dangerous") throw Object.assign(new Error("dangerous"), { code: "CONFIRMATION_REQUIRED" });
      switch (operation) {
        case "session/list":
          return { sessions: store.sessions };
        case "session/get":
          return sessionGet(store, args[0]);
        case "session/create": {
          const id = `new${store.nextId++}`;
          const session = {
            id, title: "新会话", source: "desktop", updatedAt: "2026-10-23T11:00:00Z", createdAt: "2026-10-23T11:00:00Z",
            permissionMode: "inherit", capabilities: { canPrompt: true }, mode: "agent",
            ...(args[0]?.projectPath ? { projectPath: args[0].projectPath } : {}),
            ...(args[0]?.providerId ? { providerId: args[0].providerId, modelId: args[0].modelId } : {}),
          };
          store.sessions.push(session);
          store.messages[id] = [];
          store.status[id] = { sessionId: id, isRunning: false, pendingToolConfirmations: 0 };
          return { session };
        }
        case "agent/prompt": {
          const { sessionId, content } = args[0];
          store.messages[sessionId] = [...(store.messages[sessionId] ?? []), message(`p${store.nextId++}`, "user", content)];
          store.status[sessionId] = { ...store.status[sessionId], isRunning: true };
          return { accepted: true, turnId: `turn-${store.nextId++}` };
        }
        case "agent/abort":
          store.status[args[0].sessionId] = { ...store.status[args[0].sessionId], isRunning: false };
          return { ok: true, aborted: true };
        case "agent/getStatus":
          return { status: store.status[args[0]] ?? { sessionId: args[0], isRunning: false, pendingToolConfirmations: 0 } };
        case "providers/list":
          return { providers: store.providers };
        case "providers/listModels":
          return { models: store.models[args[0].providerId] ?? [] };
        case "project/list":
          return { projects: store.projects };
        default:
          throw Object.assign(new Error(`unhandled ${operation}`), { code: "UNSUPPORTED" });
      }
    },
  };
}

export function createEvents() {
  const listeners = new Map();
  return {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
    },
    off(name, handler) {
      listeners.get(name)?.delete(handler);
    },
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    count(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

/** 只记录调用的假 WebSocket：测试自己决定何时“打开”、送帧和断开。 */
export function createFakeSockets(events) {
  const sockets = {
    connects: [],
    sent: [],
    closed: [],
    nextId: 1,
    failNext: null,
    async connect(input) {
      sockets.connects.push(input);
      if (sockets.failNext) {
        const error = sockets.failNext;
        sockets.failNext = null;
        throw error;
      }
      return { socketId: `ws-${sockets.nextId++}` };
    },
    async send({ socketId, data }) {
      sockets.sent.push({ socketId, frame: JSON.parse(data), bytes: Buffer.byteLength(data) });
    },
    async close(input) {
      sockets.closed.push(input);
    },
    deliver(socketId, frame) {
      events.emit("net:websocket:message", { type: "message", socketId, data: JSON.stringify(frame) });
    },
    drop(socketId, code = 1006, reason = "") {
      events.emit("net:websocket:close", { type: "close", socketId, code, reason, wasClean: false });
    },
    framesOf(type) {
      return sockets.sent.filter((entry) => entry.frame.type === type).map((entry) => entry.frame);
    },
  };
  return sockets;
}

export function createFakePi(options = {}) {
  const store = options.store ?? createDesktopStore();
  const events = createEvents();
  const sockets = createFakeSockets(events);
  let settings = { relayUrl: "wss://relay.example.com", agentToken: "agent-secret-token", deviceName: "Test Mac", enabled: true, ...(options.settings ?? {}) };
  const pi = {
    store,
    events,
    sockets,
    desktop: createDesktopApi(store, options.catalog),
    net: { websocket: options.websocket ?? sockets },
    plugin: {
      getId: () => "io.github.xuzihan0823.pi-remote-bridge",
      async getSettings() { return settings; },
      async setSettings(partial) { settings = { ...settings, ...partial }; },
    },
    ui: { toasts: [], async showToast(message, level) { pi.ui.toasts.push({ message, level }); } },
    commands: { registered: new Map(), async register(command) { pi.commands.registered.set(command.id, command); }, async unregister(id) { pi.commands.registered.delete(id); } },
    services: { registered: new Map(), register(service) { pi.services.registered.set(service.id, service); } },
    setSettings(next) { settings = { ...settings, ...next }; },
  };
  return pi;
}

/** 等待异步链路跑完几轮。 */
export async function flush(times = 10) {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setImmediate(resolve));
}

/** 可手动推进的计时器。 */
export function createManualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const timers = {
    now: () => now,
    setTimeout(fn, delay) {
      const id = nextId++;
      pending.set(id, { at: now + Math.max(0, delay ?? 0), fn, interval: null });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn, delay) {
      const id = nextId++;
      pending.set(id, { at: now + delay, fn, interval: delay });
      return id;
    },
    clearInterval(id) { pending.delete(id); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        let nextEntry = null;
        for (const [id, entry] of pending) if (entry.at <= target && (!nextEntry || entry.at < nextEntry[1].at)) nextEntry = [id, entry];
        if (!nextEntry) break;
        const [id, entry] = nextEntry;
        now = entry.at;
        if (entry.interval) entry.at = now + entry.interval;
        else pending.delete(id);
        entry.fn();
        await flush();
      }
      now = target;
    },
    pendingDelays() {
      return [...pending.values()].map((entry) => entry.at - now);
    },
  };
  return timers;
}
