import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const out = join(root, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "services", "claude", "src"), { recursive: true });
const common = {
  bundle: true, platform: "node", format: "esm", target: "node24", packages: "external",
  nodePaths: [join(root, "node_modules")],
};
await Promise.all([
  build({ ...common, entryPoints: [join(root, "src/main.ts")], outfile: join(out, "cli.js"), banner: { js: "#!/usr/bin/env node" } }),
  build({ ...common, entryPoints: [join(repository, "src/index.ts")], outfile: join(out, "services/relay.js") }),
  build({ ...common, entryPoints: [join(repository, "src/agent/run.ts")], outfile: join(out, "services/agent.js") }),
  build({ ...common, entryPoints: [join(repository, "backend/claude/src/index.ts")], outfile: join(out, "services/claude/src/index.js") }),
]);
await copyFile(join(repository, "macos/runtime-supervisor.mjs"), join(out, "runtime-supervisor.mjs"));
await copyFile(join(repository, "backend/claude/package.json"), join(out, "services/claude/package.json"));
await chmod(join(out, "cli.js"), 0o755);
console.log(`CLI ${JSON.parse(await readFile(join(root, "package.json"), "utf8")).version} 已构建：${out}`);
