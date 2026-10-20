import type { DesktopControlClient } from "../agent/desktop-agent-handler.ts";
import type { DesktopPermissionState } from "../protocol/types.ts";

export type { DesktopPermissionState };

export interface RemoteModel {
  provider: string;
  modelId: string;
  name: string;
}

export type DesktopPermissionMode = Exclude<DesktopPermissionState["mode"], null>;
export type DesktopEffectivePermissionMode = Exclude<DesktopPermissionState["effectiveMode"], null>;

const MAX_PROVIDERS = 128;
const MAX_MODELS = 10_000;
const MAX_TEXT = 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi Desktop 返回的数据格式无效");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Pi Desktop ${label}数据格式无效`);
  }
  return value;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\x00-\x1f\x7f]/.test(value);
}

function modelName(value: unknown, modelId: string): string {
  if (value === undefined || value === null) return modelId;
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Pi Desktop 模型数据格式无效");
  }
  return value.length > 0 ? value : modelId;
}

async function invoke(client: DesktopControlClient, operation: string, args: unknown[]): Promise<unknown> {
  const response = record(await client.call("pi_desktop_invoke", { operation, args }));
  if (response.operation !== operation || !("result" in response)) throw new Error("Pi Desktop 返回的操作结果无效");
  return response.result;
}

export async function listDesktopModels(client: DesktopControlClient): Promise<RemoteModel[]> {
  const result = record(await invoke(client, "providers/list", []));
  if (!Array.isArray(result.providers)) throw new Error("Pi Desktop 供应商列表无效");
  if (result.providers.length > MAX_PROVIDERS) throw new Error("Pi Desktop 供应商数量超过读取上限");

  const models = new Map<string, RemoteModel>();
  for (const value of result.providers) {
    const provider = record(value);
    if (provider.enabled !== true) continue;
    const providerId = text(provider.id, "供应商");
    const listed = record(await invoke(client, "providers/listModels", [{ providerId, source: "cache" }]));
    if (!Array.isArray(listed.models)) throw new Error("Pi Desktop 模型列表无效");
    for (const entry of listed.models) {
      const model = record(entry);
      const modelId = text(model.modelId, "模型");
      const key = JSON.stringify([providerId, modelId]);
      if (!models.has(key)) models.set(key, { provider: providerId, modelId, name: modelName(model.displayName, modelId) });
    }
  }
  if (models.size > MAX_MODELS) throw new Error("Pi Desktop 模型数量超过读取上限");
  return [...models.values()];
}

export function currentDesktopModel(session: Record<string, unknown>, models?: RemoteModel[]): RemoteModel | null {
  const provider = session.providerId;
  const modelId = session.modelId;
  if (!validText(provider) || !validText(modelId)) return null;
  return models?.find(model => model.provider === provider && model.modelId === modelId)
    ?? { provider, modelId, name: modelId };
}

export async function readDesktopPermission(
  client: DesktopControlClient,
  session: Record<string, unknown>,
): Promise<DesktopPermissionState> {
  const mode = session.permissionMode;
  if (mode !== "inherit" && mode !== "ask" && mode !== "accept-edits" && mode !== "auto") {
    return { mode: null, effectiveMode: null };
  }
  if (mode !== "inherit") return { mode, effectiveMode: mode };

  const settings = record(await invoke(client, "settings/get", []));
  const effectiveMode = settings.defaultPermissionMode;
  return {
    mode,
    effectiveMode: effectiveMode === "ask" || effectiveMode === "accept-edits" || effectiveMode === "auto"
      ? effectiveMode
      : null,
  };
}
