#!/usr/bin/env node
// runtime-supervisor.mjs
//
// Runs exactly one managed child process in its own process group and guarantees the whole
// tree is gone when:
//   * the job is cancelled (app closes this process' stdin),
//   * this process receives SIGTERM/SIGINT/SIGHUP,
//   * the app disappears (this process is reparented to launchd), e.g. after a force quit.
//
// Stop sequence: SIGTERM to the child only (so the agent can close pi sessions), wait the
// job's killGraceMs, then SIGKILL the child's process group as a fallback. Nothing outside the
// child's own process group is ever signalled.

import { spawn } from "node:child_process";

const originalPpid = process.ppid;

let job = null;
let child = null;
let stopping = false;
let exitCode = 0;
let readingJob = true;

function log(message) {
  process.stderr.write(`[supervisor] ${message}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killGroup(signal) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // process tree already gone
    }
  }
}

async function terminateTree() {
  if (!child || child.pid === undefined) return;
  const graceMs = job && Number.isFinite(job.killGraceMs) ? job.killGraceMs : 3000;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    const deadline = Date.now() + Math.max(3000, graceMs);
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      await delay(100);
    }
    if (child.exitCode === null && child.signalCode === null) {
      log("grace period elapsed, killing process group");
    }
  }
  killGroup("SIGKILL");
  await delay(100);
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  terminateTree()
    .catch((error) => log(`cleanup error: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => process.exit(exitCode));
}

function start() {
  const env = job.env && typeof job.env === "object" ? job.env : process.env;
  child = spawn(job.command, Array.isArray(job.args) ? job.args : [], {
    cwd: typeof job.cwd === "string" && job.cwd.length > 0 ? job.cwd : undefined,
    env: { ...env, PI_REMOTE_SUPERVISOR_PID: String(process.pid) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    log(`failed to start ${job.command}: ${error.message}`);
    exitCode = 3;
    process.exit(3);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    log(`child exited code=${code} signal=${signal}`);
    exitCode = code === null ? 1 : code;
    killGroup("SIGKILL");
    setTimeout(() => process.exit(exitCode), 50);
  });
}

const MAX_JOB_BYTES = 1024 * 1024;
let jobBuffer = "";

function consumeJob() {
  const index = jobBuffer.indexOf("\n");
  if (index < 0) {
    if (jobBuffer.length > MAX_JOB_BYTES) {
      log("job larger than 1 MiB");
      process.exit(2);
    }
    return;
  }
  readingJob = false;
  const line = jobBuffer.slice(0, index).trim();
  jobBuffer = "";
  if (line.length === 0) {
    log("empty job");
    process.exit(2);
  }
  try {
    job = JSON.parse(line);
  } catch {
    log("invalid job json");
    process.exit(2);
  }
  start();
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!readingJob) return;
  // The job line may arrive in several chunks; keep buffering until the first newline.
  jobBuffer += String(chunk);
  consumeJob();
});
process.stdin.on("end", () => {
  if (readingJob) process.exit(2);
  shutdown("stdin closed");
});
process.stdin.on("close", () => {
  if (readingJob) process.exit(2);
  shutdown("stdin closed");
});
process.stdin.on("error", () => {
  if (!readingJob) shutdown("stdin error");
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => shutdown(signal));
}

setInterval(() => {
  if (!stopping && process.ppid !== originalPpid) shutdown("parent process exited");
}, 1000).unref();
