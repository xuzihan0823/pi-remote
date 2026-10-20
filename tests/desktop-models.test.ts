import assert from "node:assert/strict";
import test from "node:test";
import { currentDesktopModel, listDesktopModels, readDesktopPermission } from "../src/desktop/models.ts";

type Operation = (args: unknown[]) => unknown;

function fake(operations: Record<string, Operation>) {
  const calls: { tool: string; args?: Record<string, unknown> }[] = [];
  const client = {
    async call(tool: string, args?: Record<string, unknown>): Promise<unknown> {
      calls.push({ tool, args });
      const operation = args?.operation;
      if (typeof operation !== "string") throw new Error("missing operation");
      const handler = operations[operation];
      if (!handler) throw new Error(`unexpected operation ${operation}`);
      return { operation, result: handler(Array.isArray(args?.args) ? args.args : []) };
    },
  };
  return { calls, client };
}

test("model catalog keeps providers distinct, ignores disabled rows and never exposes secrets", async () => {
  const { calls, client } = fake({
    "providers/list": () => ({
      providers: [
        { id: "alpha", name: "Alpha Display", enabled: true, apiKey: "sk-alpha-secret", headers: { authorization: "Bearer alpha-secret" } },
        { id: "beta", name: "Beta Display", enabled: true, secret: "beta-secret" },
        { id: "disabled", name: "Disabled", enabled: false, apiKey: "disabled-secret" },
      ],
    }),
    "providers/listModels": args => {
      const { providerId } = args[0] as { providerId: string };
      if (providerId === "alpha") {
        return {
          models: [
            { modelId: "shared", displayName: "Alpha Shared", apiKey: "model-secret" },
            { modelId: "alpha-only", displayName: "Alpha Only" },
            { modelId: "shared", displayName: "Duplicate Shared" },
          ],
        };
      }
      if (providerId === "beta") return { models: [{ modelId: "shared", displayName: "Beta Shared" }] };
      throw new Error(`unexpected provider ${providerId}`);
    },
  });

  const models = await listDesktopModels(client);

  assert.deepEqual(models, [
    { provider: "alpha", modelId: "shared", name: "Alpha Shared" },
    { provider: "alpha", modelId: "alpha-only", name: "Alpha Only" },
    { provider: "beta", modelId: "shared", name: "Beta Shared" },
  ]);
  assert.deepEqual(calls, [
    { tool: "pi_desktop_invoke", args: { operation: "providers/list", args: [] } },
    { tool: "pi_desktop_invoke", args: { operation: "providers/listModels", args: [{ providerId: "alpha", source: "cache" }] } },
    { tool: "pi_desktop_invoke", args: { operation: "providers/listModels", args: [{ providerId: "beta", source: "cache" }] } },
  ]);
  assert.doesNotMatch(JSON.stringify(models), /secret|apiKey|headers|Display/);
});

test("model catalog uses modelId when displayName is absent", async () => {
  const { client } = fake({
    "providers/list": () => ({ providers: [{ id: "custom:one", enabled: true }] }),
    "providers/listModels": () => ({ models: [{ modelId: "custom-model" }] }),
  });
  assert.deepEqual(await listDesktopModels(client), [
    { provider: "custom:one", modelId: "custom-model", name: "custom-model" },
  ]);
});

test("malformed provider and model responses throw instead of returning an empty catalog", async () => {
  const cases: Record<string, Operation>[] = [
    { "providers/list": () => ({}) },
    { "providers/list": () => ({ providers: "invalid" }) },
    { "providers/list": () => ({ providers: [{ id: "", enabled: true }] }) },
    { "providers/list": () => ({ providers: Array.from({ length: 129 }, () => ({ enabled: false })) }) },
    { "providers/list": () => ({ providers: [{ id: "alpha", enabled: true }] }), "providers/listModels": () => ({}) },
    { "providers/list": () => ({ providers: [{ id: "alpha", enabled: true }] }), "providers/listModels": () => ({ models: [{}] }) },
    { "providers/list": () => ({ providers: [{ id: "alpha", enabled: true }] }), "providers/listModels": () => ({ models: [{ modelId: "x", displayName: 42 }] }) },
  ];
  for (const operations of cases) {
    await assert.rejects(listDesktopModels(fake(operations).client), /Pi Desktop/);
  }

  const mismatched = { async call(): Promise<unknown> { return { operation: "providers/listModels", result: { providers: [] } }; } };
  await assert.rejects(listDesktopModels(mismatched), /Pi Desktop/);
});

test("currentDesktopModel uses the session identity and falls back to modelId", () => {
  const models = [
    { provider: "alpha", modelId: "shared", name: "Alpha Shared" },
    { provider: "beta", modelId: "shared", name: "Beta Shared" },
  ];

  assert.deepEqual(currentDesktopModel({ providerId: "beta", modelId: "shared" }, models), {
    provider: "beta", modelId: "shared", name: "Beta Shared",
  });
  assert.deepEqual(currentDesktopModel({ providerId: "gamma", modelId: "missing" }, models), {
    provider: "gamma", modelId: "missing", name: "missing",
  });
  assert.deepEqual(currentDesktopModel({ providerId: "gamma", modelId: "missing" }), {
    provider: "gamma", modelId: "missing", name: "missing",
  });
  assert.equal(currentDesktopModel({ providerId: "alpha" }), null);
  assert.equal(currentDesktopModel({ modelId: "shared" }), null);
  assert.equal(currentDesktopModel({ providerId: "", modelId: "shared" }), null);
});

test("inherit permission resolves the global default from settings", async () => {
  const { calls, client } = fake({
    "settings/get": () => ({ defaultPermissionMode: "auto", defaultProviderId: "alpha", apiKey: "sk-secret" }),
  });

  assert.deepEqual(await readDesktopPermission(client, { permissionMode: "inherit" }), {
    mode: "inherit", effectiveMode: "auto",
  });
  assert.deepEqual(calls, [
    { tool: "pi_desktop_invoke", args: { operation: "settings/get", args: [] } },
  ]);
});

test("inherit permission leaves effectiveMode unknown when the global setting is missing or invalid", async () => {
  for (const settings of [{}, { defaultPermissionMode: "inherit" }, { defaultPermissionMode: "future-mode" }]) {
    const { client } = fake({ "settings/get": () => settings });
    assert.deepEqual(await readDesktopPermission(client, { permissionMode: "inherit" }), {
      mode: "inherit", effectiveMode: null,
    });
  }

  const { client } = fake({ "settings/get": () => ({ defaultPermissionMode: "ask" }) });
  assert.deepEqual(await readDesktopPermission(client, { permissionMode: "inherit" }), {
    mode: "inherit", effectiveMode: "ask",
  });
});

test("inherit permission propagates settings read failures and malformed results", async () => {
  const failing = { async call(): Promise<unknown> { throw new Error("settings unavailable"); } };
  await assert.rejects(readDesktopPermission(failing, { permissionMode: "inherit" }), /settings unavailable/);

  const { client } = fake({ "settings/get": () => "invalid" });
  await assert.rejects(readDesktopPermission(client, { permissionMode: "inherit" }), /Pi Desktop 返回的数据格式无效/);
});

test("explicit permission modes never read settings and unknown modes stay unknown", async () => {
  for (const mode of ["ask", "accept-edits", "auto"] as const) {
    const { calls, client } = fake({});
    assert.deepEqual(await readDesktopPermission(client, { permissionMode: mode }), {
      mode, effectiveMode: mode,
    });
    assert.equal(calls.length, 0);
  }

  for (const session of [{}, { permissionMode: "always" }]) {
    const { calls, client } = fake({});
    assert.deepEqual(await readDesktopPermission(client, session), { mode: null, effectiveMode: null });
    assert.equal(calls.length, 0);
  }
});
