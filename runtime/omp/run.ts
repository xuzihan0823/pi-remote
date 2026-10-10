import { realpathSync } from "node:fs";
import type { StrictSessionStorage as StrictStorage } from "./strict-storage.ts";
import type { SessionManager as SessionManagerType } from "./node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts";
import { extractProfileFlags } from "./node_modules/@oh-my-pi/pi-coding-agent/src/cli/profile-bootstrap.ts";
import { resolveProfileEnv, setProfile } from "./node_modules/@oh-my-pi/pi-utils/src/dirs.ts";

const argv = process.argv.slice(2);
const profile = extractProfileFlags(argv).profile;
setProfile(profile ?? resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));

// SDK settings eagerly load profile-specific environment, so bootstrap must precede these imports.
const [{ Settings }, { resolveConfiguredModelPatterns }] = await Promise.all([
  import("./node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts"),
  import("./node_modules/@oh-my-pi/pi-coding-agent/src/config/model-resolver.ts"),
]);
if (process.env.PI_REMOTE_SUBAGENT_MODELS === undefined) {
  const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
  const independent = settings.getModelRole("task") ?? settings.getModelRole("default");
  process.env.PI_REMOTE_SUBAGENT_MODELS = JSON.stringify(resolveConfiguredModelPatterns(independent, settings));
}

const targetRaw = process.env.PI_REMOTE_STRICT_TARGET;
let storage: StrictStorage | undefined;
if (targetRaw) {
  const target = JSON.parse(targetRaw) as { file: string; id: string; cwd: string; launchId: string; instanceId: string };
  // SDK imports must follow profile bootstrap: pi-utils/env eagerly reads that profile's .env.
  const [{ StrictSessionStorage }, { SessionManager }] = await Promise.all([
    import("./strict-storage.ts"),
    import("./node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts"),
  ]);
  let generation = 0;
  let rootManager: SessionManagerType | undefined;
  let branchGeneration = 0;
  const report = () => {
    if (!storage || !argv.some(arg => arg === "rpc" || arg === "rpc-ui")) return;
    process.stdout.write(JSON.stringify({ type: "strict_identity", ...target, processId: process.pid,
      fileIdentity: storage.identity(), generation, leafId: rootManager?.getLeafId(), branchGeneration }) + "\n");
  };
  const fatal = (error: Error): never => {
    process.stderr.write(`${error.message}\n`);
    process.exit(78);
  };
  storage = new StrictSessionStorage(target, fatal, () => { generation++; report(); });
  const original = SessionManager.open.bind(SessionManager);
  SessionManager.open = async (file, directory, originalStorage, options) => {
    if (realpathSync(file) !== storage!.file) return original(file, directory, originalStorage, options);
    storage!.assert();
    const manager = await original(file, directory, storage!, { ...options, throwIfMissing: true });
    if (manager.getSessionId() !== target.id || manager.getSessionFile() !== storage!.file || realpathSync(manager.getCwd()) !== target.cwd) fatal(new Error("strict_history_loaded_identity_changed"));
    for (const name of ["newSession", "fork", "moveTo", "persistCopy", "createBranchedSession", "dropSession", "setSessionFile"] as const) {
      Object.defineProperty(manager, name, { value: () => { throw new Error("strict_history_relocation_forbidden"); } });
    }
    rootManager = manager;
    const getId = manager.getSessionId.bind(manager);
    Object.defineProperty(manager, "getSessionId", { value: () => { report(); return getId(); } });
    for (const name of ["branch", "resetLeaf", "branchWithSummary"] as const) {
      const method = manager[name].bind(manager);
      Object.defineProperty(manager, name, { value: (...args: unknown[]) => {
        const result = Reflect.apply(method, manager, args);
        branchGeneration++;
        report();
        return result;
      } });
    }
    report();
    return manager;
  };
  setInterval(() => { storage!.assert(); }, 250).unref();
  process.on("exit", () => storage?.release());
}

try {
  // The CLI lazily imports SDK/config only after the selected profile has been established.
  const { runCli } = await import("./node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts");
  await runCli(argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "controlled_runtime_failed"}\n`);
  process.exit(78);
}
