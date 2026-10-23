import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { isKnownModel, readModelCatalog } from "../../src/model-config.ts";

async function settingsFile(t: TestContext, settings: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-remote-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify(settings));
  return path;
}

test("picker catalog preserves all configured IDs, labels and order, with a redacted projection", async (t) => {
  const options = Array.from({ length: 25 }, (_, index) => ({
    model: ` provider-${index}/shared-model[1M] `,
    label: ` Model ${index} `,
    description: "private-description",
    credentials: "private-credentials",
    arbitrary: { secret: "private-field" },
  }));
  const settings = await settingsFile(t, {
    model: "fable",
    env: {
      ANTHROPIC_DEFAULT_FABLE_MODEL: options[0]?.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "hidden-provider/model",
      ANTHROPIC_API_KEY: "private-api-key",
      SECRET_VALUE: "private-env-value",
    },
    modelPicker: { options, credentials: "private-picker-value" },
    credentials: "private-settings-value",
  });

  const catalog = await readModelCatalog(settings);
  assert.deepEqual(catalog, {
    defaultModel: "provider-0/shared-model[1M]",
    models: options.map((option) => ({
      id: option.model.trim(), alias: option.model.trim(), displayName: option.label.trim(),
    })),
  });
  assert.equal(isKnownModel(catalog, "provider-24/shared-model[1M]"), true);
  assert.equal(isKnownModel(catalog, "hidden-provider/model"), false);
  for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
    assert.equal(isKnownModel(catalog, alias), true);
  }
  assert.equal(isKnownModel(catalog, "provider-25/shared-model[1M]"), false);
  assert.equal(JSON.stringify(catalog).includes("private-"), false);
});

test("picker validates unknown entries, deduplicates full trimmed IDs and supplies missing labels", async (t) => {
  const settings = await settingsFile(t, {
    modelPicker: { options: [
      null, false, 42, "provider/model", [], {}, { model: [] }, { model: 123 },
      { model: "" }, { model: " " }, { model: "bad model" }, { model: "/bad" },
      { model: "bad?model" }, { model: "a".repeat(201) },
      { model: " provider/model ", label: " First label " },
      { model: "provider/model", label: "Later label" },
      { model: "other/model", label: "  " },
      { model: "claude-no-label" },
      { model: "provider/non-string", label: { secret: "not-a-label" } },
      { model: "a".repeat(200), label: "Boundary" },
    ] },
  });

  assert.deepEqual(await readModelCatalog(settings), {
    models: [
      { id: "provider/model", alias: "provider/model", displayName: "First label" },
      { id: "other/model", alias: "other/model", displayName: "Other Model" },
      { id: "claude-no-label", alias: "claude-no-label", displayName: "No Label" },
      { id: "provider/non-string", alias: "provider/non-string", displayName: "Provider Non String" },
      { id: "a".repeat(200), alias: "a".repeat(200), displayName: "Boundary" },
    ],
  });
});

test("picker defaults resolve configured aliases and append only a missing valid default", async (t) => {
  const pickerModel = { id: "provider/model", alias: "provider/model", displayName: "Picker label" };
  const cases = [
    { name: "existing concrete default", model: " provider/model ", env: {}, expected: "provider/model" },
    { name: "mapped alias in picker", model: "sonnet", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: " provider/model " }, expected: "provider/model" },
    { name: "mapped alias outside picker", model: "opus", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "other/default" }, expected: "other/default" },
    { name: "unmapped alias", model: "fable", env: {}, expected: "fable" },
    { name: "invalid alias mapping", model: "haiku", env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "bad model" }, expected: "haiku" },
    { name: "extra concrete default", model: "other/default", env: {}, expected: "other/default" },
    { name: "missing default", model: undefined, env: {}, expected: undefined },
    { name: "invalid default", model: "bad model", env: {}, expected: undefined },
    { name: "non-string default", model: { secret: "private" }, env: {}, expected: undefined },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const settings = await settingsFile(t, {
        model: entry.model,
        env: entry.env,
        modelPicker: { options: [{ model: pickerModel.id, label: pickerModel.displayName }] },
      });
      const catalog = await readModelCatalog(settings);
      const models = [pickerModel];
      if (entry.expected !== undefined && entry.expected !== pickerModel.id) {
        models.push({
          id: entry.expected, alias: entry.expected,
          displayName: entry.expected === "other/default" ? "Other Default" : entry.expected === "fable" ? "Fable" : "Haiku",
        });
      }
      assert.deepEqual(catalog, entry.expected === undefined ? { models } : { models, defaultModel: entry.expected });
    });
  }
});

test("no valid picker options preserve the legacy alias catalog and unresolved default", async (t) => {
  const cases: unknown[] = [
    undefined, null, [], "bad", {}, { options: {} }, { options: "bad" },
    { options: [] }, { options: [null, {}, { model: "bad model" }] },
  ];
  for (const modelPicker of cases) {
    const settings = await settingsFile(t, {
      model: "fable",
      env: {
        ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5[1M]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.6-sol[1M]",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-4-7",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.2[1m]",
        ANTHROPIC_API_KEY: "must-not-appear",
      },
      modelPicker,
    });
    const catalog = await readModelCatalog(settings);
    assert.deepEqual(catalog, {
      defaultModel: "fable",
      models: [
        { alias: "fable", displayName: "Fable", id: "claude-fable-5[1M]" },
        { alias: "opus", displayName: "Opus", id: "gpt-5.6-sol[1M]" },
        { alias: "sonnet", displayName: "Sonnet", id: "claude-opus-4-7" },
        { alias: "haiku", displayName: "Haiku", id: "glm-5.2[1m]" },
      ],
    });
    assert.equal(isKnownModel(catalog, "gpt-5.6-sol[1M]"), true);
  }
});

test("legacy catalog prepends extra defaults and falls back for invalid alias mappings", async (t) => {
  const settings = await settingsFile(t, {
    model: " provider/custom ",
    env: { ANTHROPIC_DEFAULT_FABLE_MODEL: "bad model", ANTHROPIC_DEFAULT_OPUS_MODEL: 123 },
  });
  assert.deepEqual(await readModelCatalog(settings), {
    defaultModel: "provider/custom",
    models: [
      { id: "provider/custom", alias: "provider/custom", displayName: "Provider Custom" },
      { id: "fable", alias: "fable", displayName: "Fable" },
      { id: "opus", alias: "opus", displayName: "Opus" },
      { id: "sonnet", alias: "sonnet", displayName: "Sonnet" },
      { id: "haiku", alias: "haiku", displayName: "Haiku" },
    ],
  });
});

test("missing, malformed or non-object settings fall back to SDK aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-remote-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = join(root, "settings.json");
  for (const contents of [undefined, "not-json", "null", "[]", "42", '{"model":"bad model"}']) {
    if (contents !== undefined) await writeFile(settings, contents);
    const catalog = await readModelCatalog(settings);
    assert.equal(catalog.defaultModel, undefined);
    assert.deepEqual(catalog.models.map((model) => model.alias), ["fable", "opus", "sonnet", "haiku"]);
  }
});
