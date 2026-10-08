import { isAbsolute, parse, relative, resolve, sep } from "node:path";

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function sessionRoots(defaultDirectory: string): Promise<string[]> {
  return [parse(resolve(defaultDirectory)).root];
}
