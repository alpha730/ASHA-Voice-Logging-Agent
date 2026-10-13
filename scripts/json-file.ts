// JSON files the scripts edit: read, and write back in the file's own style (2-space indent and its
// existing line endings), so a diff shows only what changed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const readJson = <T = unknown>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function writeJson(path: string, data: unknown): void {
  const eol = existsSync(path) && readFileSync(path, "utf8").includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(path, (JSON.stringify(data, null, 2) + "\n").replace(/\n/g, eol));
}
