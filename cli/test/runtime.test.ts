import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lines, ProcessGroup, redact } from "../src/processes.ts";
import { tunnelURL, waitFor } from "../src/tunnel.ts";

test("按完整行解码分块日志和 Unicode", () => {
  const seen: string[] = [], reader = lines((line) => seen.push(line));
  const data = Buffer.from("中文\r\nnext\nlast");
  reader.write(data.subarray(0, 1)); reader.write(data.subarray(1, 7)); reader.write(data.subarray(7)); reader.end();
  assert.deepEqual(seen, ["中文", "next", "last"]);
});
test("仅接受完整的 Cloudflare HTTPS origin", () => {
  assert.equal(tunnelURL("| https://test-tunnel.trycloudflare.com |"), "https://test-tunnel.trycloudflare.com");
  for (const value of ["https://trycloudflare.com", "https://foo.trycloudflare.com.evil.test", "https://evil-trycloudflare.com", "https://x.trycloudflare.com/path", "https://x.trycloudflare.com?q=1", "https://x.trycloudflare.com#fragment", "https://u:p@x.trycloudflare.com", "https://x.trycloudflare.com:8443"]) assert.equal(tunnelURL(value), undefined, value);
});
test("等待支持超时和取消，脱敏处理凭据与终端控制字符", async () => {
  await assert.rejects(waitFor("测试", async () => undefined, new AbortController().signal, 1), /超时/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitFor("测试", async () => true, controller.signal));
  const output = redact("token=private ?token=encoded\u001b[31m", ["private"]);
  assert.ok(!output.includes("private") && !output.includes("encoded") && !output.includes("\u001b"));
});

test("正常退出和意外退出均清理独立进程组", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cli-process-"));
  const supervisor = resolve(import.meta.dirname, "../../macos/runtime-supervisor.mjs");
  try {
    for (const crashes of [false, true]) {
      const pidfile = join(directory, `pid-${crashes}`), script = join(directory, `child-${crashes}.mjs`);
      await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidfile)},String(c.pid));${crashes ? "setTimeout(()=>process.exit(7),500);" : "setInterval(()=>{},1000);"}`);
      const group = new ProcessGroup(supervisor);
      group.start({ command: process.execPath, args: [script], cwd: directory, env: process.env, tag: "fixture", killGraceMs: 3000 }, () => {});
      const pid = await waitFor("子进程就绪", async () => { try { return Number(await readFile(pidfile, "utf8")); } catch { return undefined; } }, group.signal, 4000);
      if (crashes) await new Promise<void>((done) => group.signal.addEventListener("abort", () => done(), { once: true }));
      await group.stop();
      if (crashes) assert.match(group.failure?.message ?? "", /意外退出/);
      let alive = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(pid, 0); await delay(50); } catch { alive = false; break; }
      }
      assert.equal(alive, false, `grandchild ${pid} remains`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
