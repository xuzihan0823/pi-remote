import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelOption {
  /** Concrete model identifier resolved from Mac settings. */
  id: string;
  /** Stable CLI alias accepted by the Agent SDK. */
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
 * Only `model` and the four documented model-alias environment keys are read.
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
  const models: ModelOption[] = MODEL_ALIASES.map(({ alias, displayName, envKey }) => ({
    alias,
    displayName,
    id: modelId(env[envKey]) ?? alias,
  }));
  const defaultModel = modelId(settings.model);

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
  return catalog.models.some((model) => model.alias === value || model.id === value);
}
