#!/usr/bin/env node
// 将 backend/claude 打包成一个自包含 runtime 目录：
//
//   <out>/src/**           TypeScript 源码（Node 原生类型剥离直接运行）
//   <out>/package.json     原样复制
//   <out>/package-lock.json 原样复制
//   <out>/node_modules/**  package-lock 锁定的 production 依赖闭包
//
// 设计约束：
//  - 不联网、不调用 npm；只从本机已安装的 node_modules 复制闭包内文件。
//  - 源包路径由 import.meta.url 推导，与 cwd 无关。
//  - 输出目录必须全新或为空；拒绝 backend 源码目录、其祖先、以及任何 node_modules。
//  - package-lock packages[path].dev === true 一律跳过；optional 依赖缺失（平台不适用）可
//    忽略，required 依赖缺失直接报错。
//  - 不含 backend 的 test/、devDependencies（typescript/@types）、.env/pem/key 等机密与用户数据。

import { cp, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..");

/** 复制过滤器：剔除机密文件与测试目录（runtime 不需要）。 */
function keepForBundle(src) {
  const name = basename(src);
  if (name === ".env" || name.startsWith(".env.") || name === ".npmrc") return false;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".pfx")) return false;
  if (name === "test" || name === "tests" || name === "__tests__") return false;
  return true;
}

function parentPackagePath(packagePath) {
  return packagePath.replace(/\/?node_modules\/(?:@[^/]+\/)?[^/]+\/?$/, "");
}

/** 按 Node 解析规则在 lockfile 的安装布局中定位依赖。 */
function resolvePackagePath(packages, fromPath, name) {
  let dir = fromPath;
  for (;;) {
    const candidate = `${dir === "" ? "node_modules/" : `${dir}/node_modules/`}${name}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (dir === "") return undefined;
    dir = parentPackagePath(dir);
  }
}

function platformCompatible(entry, platform = process.platform, arch = process.arch) {
  if (entry.os !== undefined && !entry.os.includes(platform)) return false;
  if (entry.cpu !== undefined && !entry.cpu.includes(arch)) return false;
  return true;
}

/**
 * 从 lockfile 计算 production 依赖闭包。
 * 返回 Map<pkgPath, { optional: boolean }>，required 缺失（lockfile 无此条目）会抛错。
 */
function computeClosure(packages) {
  const root = packages[""];
  if (root === undefined) throw new Error("package-lock.json 缺少根 packages[\"\"] 条目");
  const closure = new Map();
  const queue = [];
  for (const name of Object.keys(root.dependencies ?? {})) queue.push({ from: "", name, optional: false, peer: false });
  for (const name of Object.keys(root.optionalDependencies ?? {})) queue.push({ from: "", name, optional: true, peer: false });

  while (queue.length > 0) {
    const { from, name, optional, peer } = queue.shift();
    const packagePath = resolvePackagePath(packages, from, name);
    if (packagePath === undefined) {
      if (optional || peer) continue; // peer/optional 缺失可容忍
      throw new Error(`required dependency missing from lockfile: ${name} (required by ${from || "root"})`);
    }
    const entry = packages[packagePath];
    if (entry.dev === true) continue; // 明确跳过 dev 依赖
    if (entry.optional === true && !platformCompatible(entry)) continue; // 平台不适用的 optional
    if (closure.has(packagePath)) continue;
    closure.set(packagePath, { optional: entry.optional === true });
    const optionalNames = new Set(Object.keys(entry.optionalDependencies ?? {}));
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      queue.push({ from: packagePath, name: dep, optional: optionalNames.has(dep), peer: false });
    }
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) {
      queue.push({ from: packagePath, name: dep, optional: true, peer: false });
    }
    for (const dep of Object.keys(entry.peerDependencies ?? {})) {
      queue.push({ from: packagePath, name: dep, optional: false, peer: true });
    }
  }
  return closure;
}

/** 解析路径到真实位置（允许目标尚不存在，回溯到最近的已存在祖先）。 */
async function realpathExtended(target) {
  const suffix = [];
  let current = resolve(target);
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function isStrictlyInside(child, parent) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 输出目录安全校验：不得是 backend 源目录/其祖先、不得位于 backend 内、不得含 node_modules。 */
async function assertSafeOutput(outDir) {
  const outReal = await realpathExtended(outDir);
  const backendReal = await realpath(BACKEND_ROOT);
  if (outReal === backendReal) throw new Error(`拒绝输出到 backend 源码目录: ${outReal}`);
  if (isStrictlyInside(backendReal, outReal)) throw new Error(`拒绝对 backend 源码目录的祖先输出: ${outReal}`);
  if (isStrictlyInside(outReal, backendReal)) throw new Error(`拒绝输出到 backend 源码目录内部: ${outReal}`);
  if (outReal.split(sep).includes("node_modules")) throw new Error(`拒绝输出到 node_modules 内: ${outReal}`);
  return outReal;
}

async function prepareEmptyDir(outDir) {
  let exists = true;
  try {
    const info = await stat(outDir);
    if (!info.isDirectory()) throw new Error(`输出路径已存在且不是目录: ${outDir}`);
  } catch (error) {
    if (error?.code === "ENOENT") exists = false;
    else throw error;
  }
  if (!exists) {
    await mkdir(outDir, { recursive: true });
    return;
  }
  const entries = await readdir(outDir);
  if (entries.length > 0) throw new Error(`输出目录非空，拒绝覆盖: ${outDir}`);
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    console.error("用法: node scripts/package-runtime.mjs <输出目录>");
    process.exit(args.length === 1 ? 0 : 2);
  }
  const requested = resolve(args[0]);
  const outDir = await assertSafeOutput(requested);
  await prepareEmptyDir(outDir);

  const lock = JSON.parse(await readFile(join(BACKEND_ROOT, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};
  const closure = computeClosure(packages);

  await cp(join(BACKEND_ROOT, "src"), join(outDir, "src"), { recursive: true, filter: keepForBundle });
  await cp(join(BACKEND_ROOT, "package.json"), join(outDir, "package.json"));
  await cp(join(BACKEND_ROOT, "package-lock.json"), join(outDir, "package-lock.json"));

  let copied = 0;
  let skippedOptional = 0;
  for (const packagePath of [...closure.keys()].sort()) {
    const source = join(BACKEND_ROOT, packagePath);
    const destination = join(outDir, packagePath);
    if (!(await pathExists(source))) {
      if (closure.get(packagePath).optional) {
        skippedOptional += 1;
        continue;
      }
      throw new Error(`required dependency 未安装: ${packagePath}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, filter: keepForBundle });
    copied += 1;
  }

  console.log(`runtime 已打包到 ${outDir}`);
  console.log(`  packages: ${copied} (skipped optional: ${skippedOptional})`);
}

main().catch((error) => {
  console.error(`package-runtime failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
