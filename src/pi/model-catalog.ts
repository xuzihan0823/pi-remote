import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publicModels, type RemoteModel } from "../terminal/extension.ts";
import { resolveTerminalExecutable, terminalEnvironment } from "../terminal/launcher.ts";

export type ModelCatalog = (cwd: string, mode: "terminal" | "rpc") => Promise<RemoteModel[]>;
type CatalogRunner = (file: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: "utf8";
}) => Promise<{ stdout: string }>;

export function createModelCatalog(options: { piBin: string; runtime: "pi" | "omp"; run?: CatalogRunner }): ModelCatalog {
  const run = options.run ?? promisify(execFile);
  return async (cwd, mode) => {
    const binary = await resolveTerminalExecutable(options.piBin);
    const { stdout } = await run(binary, options.runtime === "omp" ? ["models", "--json"] : ["--list-models"], {
      cwd, env: { ...(mode === "terminal" ? terminalEnvironment() : process.env), NO_COLOR: "1", FORCE_COLOR: "0" },
      timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
    });
    return parseModelCatalog(stdout, options.runtime);
  };
}

export function parseModelCatalog(output: string, runtime: "pi" | "omp"): RemoteModel[] {
  if (runtime === "omp") return publicModels((JSON.parse(output) as { models?: unknown }).models);
  const lines = output.trim().split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0 || /^No models available\b/i.test(lines[0]!)) return [];
  if (!/^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/.test(lines[0]!)) {
    throw new Error("Pi 模型列表格式不受支持，请更新 Pi");
  }
  const models = lines.slice(1).map(line => {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length !== 6 || !["yes", "no"].includes(columns[4]!)) throw new Error("Pi 模型列表格式无效");
    return { provider: columns[0], id: columns[1], reasoning: columns[4] === "yes" };
  });
  return publicModels(models);
}
