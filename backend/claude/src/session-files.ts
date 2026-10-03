// sessionId → JSONL 文件定位与 cwd 提取（HTTP 层胶水）。
//
// 定位逻辑与 SessionWatcher.#resolveFile 一致：遍历 projectsDir 下项目目录找
// `<sessionId>.jsonl`。cwd 从文件头部行内字段读取（决策：不从目录名反解），
// 拿到即断流；整个文件没有 cwd 时返回 ""（调用方决定回退值）。

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** 定位会话文件；不存在时抛 code=ENOENT 错误（HTTP 层转 404）。 */
export async function resolveSessionFile(projectsDir: string, sessionId: string): Promise<string> {
  const name = `${sessionId}.jsonl`;
  const dirents = await readdir(projectsDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const candidate = join(projectsDir, dirent.name, name);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // 该项目目录下没有，继续
    }
  }
  const error = new Error(`session file not found: ${sessionId}`);
  (error as NodeJS.ErrnoException).code = "ENOENT";
  throw error;
}

const CWD_SCAN_MAX_LINES = 200;

/** 头部流式扫首个带 cwd 字段的行，拿到即断流。没有则 ""。 */
export async function readSessionCwd(file: string): Promise<string> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of lines) {
      seen += 1;
      if (seen > CWD_SCAN_MAX_LINES) break;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const o: unknown = JSON.parse(trimmed);
        if (typeof o === "object" && o !== null && !Array.isArray(o)) {
          const cwd = (o as Record<string, unknown>).cwd;
          if (typeof cwd === "string" && cwd !== "") return cwd;
        }
      } catch {
        // 坏行跳过
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return "";
}
