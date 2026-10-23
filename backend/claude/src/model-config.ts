import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelOption {
  /** Concrete model identifier resolved from Mac settings. */
  id: string;
  /** CLI alias or configured model identifier accepted by the Agent SDK. */
  alias: string;
  displayName: string;
}

export interface ModelCatalog {
  models: ModelOption[];
  defaultModel?: string;
}

const MODEL_ALIASES = [
  { alias: "fable", displayName: "Fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
  { alias: "opus", displayName: "Opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  { alias: "sonnet", displayName: "Sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
  { alias: "haiku", displayName: "Haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
] as const;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]{0,199}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function modelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return MODEL_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function displayNameForModel(id: string): string {
  const words = id.replace(/^claude-/, "").split(/[-_.:/]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Read a deliberately narrow, redacted projection of ~/.claude/settings.json.
 * Only model identifiers, aliases, and display names are projected.
 */
export async function readModelCatalog(
  settingsPath = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "settings.json"),
): Promise<ModelCatalog> {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    settings = record(parsed) ?? {};
  } catch {
    // Missing/malformed settings must not prevent daemon startup or model listing.
  }

  const env = record(settings.env) ?? {};
  const defaultModel = modelId(settings.model);
  const pickerOptions = record(settings.modelPicker)?.options;
  const pickerModels: ModelOption[] = [];
  const seen = new Set<string>();
  if (Array.isArray(pickerOptions)) {
    for (const value of pickerOptions) {
      const option = record(value);
      const id = modelId(option?.model);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const label = typeof option?.label === "string" ? option.label.trim() : "";
      pickerModels.push({ id, alias: id, displayName: label || displayNameForModel(id) });
    }
  }

  if (pickerModels.length > 0) {
    const defaultAlias = MODEL_ALIASES.find(({ alias }) => alias === defaultModel);
    const resolvedDefault = defaultAlias === undefined
      ? defaultModel
      : modelId(env[defaultAlias.envKey]) ?? defaultModel;
    if (resolvedDefault !== undefined && !seen.has(resolvedDefault)) {
      pickerModels.push({
        id: resolvedDefault,
        alias: resolvedDefault,
        displayName: displayNameForModel(resolvedDefault),
      });
    }
    return resolvedDefault === undefined ? { models: pickerModels } : { models: pickerModels, defaultModel: resolvedDefault };
  }

  const models: ModelOption[] = MODEL_ALIASES.map(({ alias, displayName, envKey }) => ({
    alias,
    displayName,
    id: modelId(env[envKey]) ?? alias,
  }));

  if (
    defaultModel !== undefined
    && !models.some((model) => model.alias === defaultModel || model.id === defaultModel)
  ) {
    models.unshift({
      id: defaultModel,
      alias: defaultModel,
      displayName: displayNameForModel(defaultModel),
    });
  }

  return defaultModel === undefined ? { models } : { models, defaultModel };
}

export function isKnownModel(catalog: ModelCatalog, value: string): boolean {
  return MODEL_ALIASES.some(({ alias }) => alias === value)
    || catalog.models.some((model) => model.alias === value || model.id === value);
}
