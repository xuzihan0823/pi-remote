#!/usr/bin/env node
// Minimal "app" stand-in used by supervisor-lifecycle.mjs: it starts the supervisor with a job
// and then force-quits itself (SIGKILL), exactly like a crashed/killed Pi Remote.app.

import { spawn } from "node:child_process";
import os from "node:os";

const [, , supervisorPath, nodePath] = process.argv;
const marker = process.env.TEST_MARKER;
const grandchildMarker = process.env.TEST_GRANDCHILD_MARKER;

if (!supervisorPath || !nodePath || !marker || !grandchildMarker) {
  console.error("fake-app: missing arguments");
  process.exit(2);
}

const script = [
  'const { spawn } = require("node:child_process");',
  `spawn(process.execPath, ["-e", 'setInterval(()=>{},1000);/* ${grandchildMarker} */'], { stdio: "ignore" });`,
  "setInterval(()=>{},1000);",
  `/* ${marker} */`,
].join("\n");

const job = {
  command: nodePath,
  args: ["-e", script],
  cwd: os.tmpdir(),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.tmpdir() },
  killGraceMs: 1000,
  tag: "test",
};

const supervisor = spawn(nodePath, [supervisorPath], { stdio: ["pipe", "inherit", "inherit"] });
supervisor.stdin.write(`${JSON.stringify(job)}\n`);

setTimeout(() => {
  process.kill(process.pid, "SIGKILL");
}, 1500);
