import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isKnownModel, readModelCatalog } from "../../src/model-config.ts";

test("model catalog exposes only safe model identifiers and redacts unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-remote-models-"));
  const settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({
    model: "fable",
    env: {
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5[1M]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.6-sol[1M]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-4-7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.2[1m]",
      ANTHROPIC_API_KEY: "must-not-appear",
      SECRET_VALUE: "must-not-appear",
    },
  }));

  const catalog = await readModelCatalog(settings);
  assert.equal(catalog.defaultModel, "fable");
  assert.deepEqual(catalog.models.find((model) => model.alias === "fable"), {
    alias: "fable", displayName: "Fable", id: "claude-fable-5[1M]",
  });
  assert.equal(isKnownModel(catalog, "gpt-5.6-sol[1M]"), true);
  assert.equal(JSON.stringify(catalog).includes("must-not-appear"), false);
});

test("missing or malformed settings fall back to SDK aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-remote-models-"));
  const settings = join(root, "settings.json");
  await writeFile(settings, "not-json");
  const catalog = await readModelCatalog(settings);
  assert.equal(catalog.defaultModel, undefined);
  assert.deepEqual(catalog.models.map((model) => model.alias), ["fable", "opus", "sonnet", "haiku"]);
});
