import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PiProcessManager, SessionProcessStatus } from "../pi/process-manager.ts";
import { relayError, type RelayErrorCode } from "../protocol/relay-types.ts";
import type { GatewayEvent, UiDialogResponse } from "../protocol/types.ts";
import {
  TerminalBridgeError,
  isTerminalSessionId,
  type TerminalSessionBridge,
  type TerminalSessionMeta,
} from "../terminal/bridge-client.ts";
import type { AgentHandlerResult, AgentRequestHandler } from "./agent-client.ts";
import type { TerminalSessionLauncher } from "../terminal/launcher.ts";

export interface PiAgentHandlerOptions {
  manager: PiProcessManager;
  workspaceRoot: string;
  terminalBridge?: TerminalSessionBridge;
  terminalLauncher?: Pick<TerminalSessionLauncher, "start">;
  emitSessionEvent?: (sessionId: string, event: GatewayEvent) => void;
  logger?: (message: string) => void;
}

/**
 * Bridges relay requests to a local PiProcessManager. The returned handler never starts a
 * session on its own: a process is spawned only when a client sends `session.start`.
 * Every GatewayEvent the manager produces is forwarded through `emitSessionEvent` so the
 * caller can relay streaming state, while request responses only acknowledge what was queued.
 */
export function createPiAgentHandler(options: PiAgentHandlerOptions): AgentRequestHandler {
  const { manager, workspaceRoot, terminalBridge } = options;
  const logger = options.logger ?? (() => {});
  const emitSessionEvent = options.emitSessionEvent ?? (() => {});

  manager.onEvent((event) => {
    emitSessionEvent(event.sessionId, event);
  });

  const listSessions = async (): Promise<Record<string, unknown>[]> => {
    const sessions: Record<string, unknown>[] = manager.list().map(toManagedSessionEntry);
    if (!terminalBridge) return sessions;

    let terminalSessions: TerminalSessionMeta[];
    try {
      terminalSessions = await terminalBridge.list();
    } catch (error) {
      logger(`terminal session list failed: ${error instanceof Error ? error.message : String(error)}`);
      return sessions;
    }

    const seen = new Set(sessions.map((entry) => entry.sessionId));
    for (const session of terminalSessions) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      // A terminal entry exists only while its bridge socket answers, so it is by definition running.
      sessions.push({ ...session, source: "terminal", state: "running" });
    }
    return sessions;
  };

  return async (request) => {
    const method = request.payload.method;
    const params = request.payload.params ?? {};
    const sessionId = nonEmptyString(request.sessionId) ?? stringParam(params, "sessionId");
    logger(`handling ${method}${sessionId ? ` for session "${sessionId}"` : ""}`);

    try {
      switch (method) {
        case "session.list":
          return { ok: true, data: { sessions: await listSessions() } };

        case "session.get": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.get requires sessionId");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            return { ok: true, data: await terminalBridge.snapshot(sessionId) };
          }
          return {
            ok: false,
            error: relayError(
              "not_implemented",
              "session.get is only implemented for terminal sessions; managed sessions have no history API",
            ),
          };
        }

        case "session.start": {
          const mode = params.mode === undefined ? "rpc" : params.mode;
          if (mode !== "rpc" && mode !== "terminal") throw new HandlerError("invalid_frame", "params.mode must be terminal or rpc");
          if (mode === "terminal") {
            if (params.args !== undefined) throw new HandlerError("invalid_frame", "terminal mode does not accept remote args");
            if (sessionId) throw new HandlerError("invalid_frame", "terminal mode creates a new session and does not accept sessionId");
            if (!options.terminalLauncher) throw new HandlerError("not_implemented", "terminal session creation is unavailable");
            const session = await options.terminalLauncher.start(params.cwd);
            return { ok: true, data: { sessionId: session.sessionId, source: "terminal", status: { ...session, source: "terminal", state: "running" } } };
          }
          if (sessionId && isTerminalSessionId(sessionId)) throw new HandlerError("invalid_frame", "RPC mode cannot create or resume a terminal session");
          const startedId = sessionId ?? randomUUID();
          const cwd = resolveWorkspaceCwd(workspaceRoot, params.cwd);
          const args = stringArrayParam(params, "args");
          const status = await manager.start(startedId, { cwd, ...(args ? { args } : {}) });
          return { ok: true, data: { sessionId: startedId, source: "managed", status } };
        }

        case "session.prompt": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.prompt requires sessionId");
          const message = stringParam(params, "message");
          if (!message) throw new HandlerError("invalid_frame", "session.prompt requires a non-empty message");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            await terminalBridge.prompt(sessionId, message);
            return { ok: true, data: { sessionId, queued: true } };
          }
          await manager.prompt(sessionId, message, Array.isArray(params.images) ? { images: params.images } : {});
          return { ok: true, data: { sessionId, queued: true } };
        }

        case "session.abort": {
          if (!sessionId) throw new HandlerError("invalid_frame", "session.abort requires sessionId");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            await terminalBridge.abort(sessionId);
            return { ok: true, data: { sessionId, aborted: true } };
          }
          await manager.abort(sessionId);
          return { ok: true, data: { sessionId, aborted: true } };
        }

        case "ui.response": {
          if (!sessionId) throw new HandlerError("invalid_frame", "ui.response requires sessionId");
          const requestId = stringParam(params, "requestId");
          if (!requestId) throw new HandlerError("invalid_frame", "ui.response requires a non-empty requestId");
          if (terminalBridge && isTerminalSessionId(sessionId)) {
            return {
              ok: false,
              error: relayError(
                "not_implemented",
                "extension UI prompts for terminal sessions must be answered in the Mac terminal",
              ),
            };
          }
          const client = manager.get(sessionId);
          if (!client) throw new HandlerError("unknown_session", `No pi process for session "${sessionId}"`);
          client.respondToUi(requestId, asDialogResponse(params.response));
          return { ok: true, data: { sessionId, requestId } };
        }

        default:
          return {
            ok: false,
            error: relayError("not_implemented", `Method "${method}" is not implemented by the agent`),
          };
      }
    } catch (error) {
      return toHandlerError(error);
    }
  };
}

class HandlerError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "HandlerError";
    this.code = code;
  }
}

function toHandlerError(error: unknown): AgentHandlerResult {
  if (error instanceof TerminalBridgeError) {
    return { ok: false, error: relayError(error.code, error.message) };
  }
  if (error instanceof HandlerError) {
    return { ok: false, error: relayError(error.code, error.message) };
  }

  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;

  switch (code) {
    case "session_not_found":
      return { ok: false, error: relayError("unknown_session", message) };
    case "session_busy":
    case "session_already_running":
      return { ok: false, error: relayError("session_busy", message) };
    default:
      return { ok: false, error: relayError("internal_error", message) };
  }
}

function toManagedSessionEntry(status: SessionProcessStatus): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ...status,
    source: "managed",
    title: status.title ?? status.sessionId,
    activity: status.state === "running" && status.busy ? "busy" : "idle",
  };
  if (status.cwd) entry.cwd = status.cwd;
  return entry;
}

function resolveWorkspaceCwd(workspaceRoot: string, requested: unknown): string {
  const resolvedRoot = resolve(workspaceRoot);
  if (requested === undefined || requested === null) return resolvedRoot;
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new HandlerError("invalid_frame", "params.cwd must be a non-empty string");
  }

  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(resolvedRoot, requested);
  const relativePath = relative(resolvedRoot, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new HandlerError("invalid_frame", `params.cwd "${requested}" is outside the workspace root`);
  }
  return candidate;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asDialogResponse(value: unknown): UiDialogResponse {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const response: UiDialogResponse = {};
  if (typeof record.value === "string") response.value = record.value;
  if (typeof record.confirmed === "boolean") response.confirmed = record.confirmed;
  if (typeof record.cancelled === "boolean") response.cancelled = record.cancelled;
  return response;
}
