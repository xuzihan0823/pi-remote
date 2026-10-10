import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function backgroundFixture() {
  const root = await realpath(await mkdtemp("/tmp/pi-bg-test-"));
  const cwd = join(root, "workspace");
  const sessions = join(root, "sessions");
  const bucket = join(sessions, "bucket");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(bucket, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const file = join(bucket, `${id}.jsonl`);
  const timestamp = new Date().toISOString();
  const entries: Record<string, unknown>[] = [{ type: "session", version: 3, id, cwd, timestamp }];
  let parent: string | null = null;
  for (let i = 0; i < 130; i++) {
    const entryId = `old-${i}`;
    entries.push({ type: "message", id: entryId, parentId: parent, timestamp, message: { role: "user", content: [{ type: "text", text: `synthetic ${i}` }], timestamp: Date.now() } });
    parent = entryId;
  }
  entries.push({ type: "message", id: "call", parentId: parent, timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "test-tool", name: "read", arguments: { path: "synthetic.txt" } }], timestamp: Date.now() } });
  entries.push({ type: "message", id: "result", parentId: "call", timestamp, message: { role: "toolResult", toolCallId: "test-tool", toolName: "read", content: [{ type: "text", text: "synthetic tool result\n".repeat(6000) }], timestamp: Date.now() } });
  entries.push({ type: "message", id: "wrong", parentId: "result", timestamp, message: { role: "user", content: [{ type: "text", text: "wrong branch" }], timestamp: Date.now() } });
  entries.push({ type: "message", id: "right", parentId: "result", timestamp, message: { role: "user", content: [{ type: "text", text: "correct last branch" }], timestamp: Date.now() } });
  await writeFile(file, entries.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  return { root, cwd, sessions, bucket, id, file, original: await readFile(file, "utf8") };
}
