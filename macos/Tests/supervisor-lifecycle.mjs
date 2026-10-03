#!/usr/bin/env node
// Verifies runtime-supervisor.mjs lifecycle:
//   1. the job line is accepted even when it arrives split across writes;
//   2. cancelling the supervisor (stdin closed) removes the child AND its grandchild;
//   3. a force-quit parent (SIGKILL) still results in the whole tree being removed.
// Uses pgrep for read-only assertions; nothing is ever pattern-killed.

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const supervisorPath = path.resolve(here, "..", "runtime-supervisor.mjs");
const fakeAppPath = path.join(here, "fixtures", "fake-app.mjs");
const nodePath = process.execPath;

const failures = [];

function check(condition, description) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    console.log(`  FAIL ${description}`);
    failures.push(description);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pgrepCount(pattern) {
  const result = spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return 0;
  return result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

async function waitForGone(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pgrepCount(pattern) === 0) return true;
    await delay(100);
  }
  return pgrepCount(pattern) === 0;
}

async function waitForAtLeastOne(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pgrepCount(pattern) >= 1) return true;
    await delay(100);
  }
  return pgrepCount(pattern) >= 1;
}

function childScript(marker, grandchildMarker) {
  return [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", 'setInterval(()=>{},1000);/* ${grandchildMarker} */'], { stdio: "ignore" });`,
    'setInterval(()=>{},1000);',
    `/* ${marker} */`,
  ].join("\n");
}

function buildJob(marker, grandchildMarker) {
  return {
    command: nodePath,
    args: ["-e", childScript(marker, grandchildMarker)],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.tmpdir() },
    killGraceMs: 1000,
    tag: "test",
  };
}

async function testSplitWriteAndCancel() {
  console.log("1. 分包写入 + 取消（stdin 关闭）");
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const marker = `PIRMTEST_CHILD_${stamp}`;
  const grandchild = `PIRMTEST_GRAND_${stamp}`;

  const supervisor = spawn(nodePath, [supervisorPath], { stdio: ["pipe", "pipe", "pipe"] });
  const line = `${JSON.stringify(buildJob(marker, grandchild))}\n`;
  const split = Math.floor(line.length / 2);
  supervisor.stdin.write(line.slice(0, split));
  await delay(300);
  check(pgrepCount(marker) === 0, "首行未完整前不启动子进程");
  supervisor.stdin.write(line.slice(split));

  check(await waitForAtLeastOne(marker, 5000), "分包写入后子进程启动");
  check(await waitForAtLeastOne(grandchild, 5000), "子进程派生的孙进程也在运行");

  supervisor.stdin.end();
  const childGone = await waitForGone(marker, 10000);
  const grandchildGone = await waitForGone(grandchild, 5000);
  check(childGone, "取消后子进程被清理");
  check(grandchildGone, "取消后孙进程被清理");

  const exitCode = await new Promise((resolve) => supervisor.once("exit", (code) => resolve(code)));
  check(exitCode === 0, `取消时 supervisor 正常退出（exit=${exitCode}）`);
}

async function testForceQuitParent() {
  console.log("2. 强退 App（父进程被 SIGKILL）");
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const marker = `PIRMTEST_CHILD_${stamp}`;
  const grandchild = `PIRMTEST_GRAND_${stamp}`;

  const fakeApp = spawn(nodePath, [fakeAppPath, supervisorPath, nodePath, "force"], {
    env: { ...process.env, TEST_MARKER: marker, TEST_GRANDCHILD_MARKER: grandchild },
    stdio: ["ignore", "inherit", "inherit"],
  });
  check(await waitForAtLeastOne(marker, 6000), "父进程存活时代理子进程在运行");
  await new Promise((resolve) => fakeApp.once("exit", resolve));

  const childGone = await waitForGone(marker, 12000);
  const grandchildGone = await waitForGone(grandchild, 5000);
  check(childGone, "父进程被强杀后子进程被清理");
  check(grandchildGone, "父进程被强杀后孙进程被清理");
}

async function main() {
  await testSplitWriteAndCancel();
  await testForceQuitParent();
  if (failures.length > 0) {
    console.error(`supervisor 生命周期验证失败：${failures.length} 项`);
    process.exit(1);
  }
  console.log("supervisor 生命周期验证全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
