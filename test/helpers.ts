import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const TRACKED_FILE = "README";
export const UNTRACKED_FILE = "NEW.txt";

export type RepoFile = { path: string; body: string };

export function gitRepo(dir: string, files: readonly RepoFile[] = []): void {
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, TRACKED_FILE), "x\n");
  for (const file of files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.body);
  }
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

export function headSha(dir: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

export function porcelainOf(dir: string): string {
  return spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
}

export function writeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

export function writeFakeAgent(binDir: string, name = "cursor-agent"): string {
  return writeBin(
    binDir,
    name,
    `#!/usr/bin/env python3
open(${JSON.stringify(TRACKED_FILE)}, "a").write("agent edit\\n")
open(${JSON.stringify(UNTRACKED_FILE)}, "w").write("new file\\n")
print('{"type":"result","result":"edited ${TRACKED_FILE}, added ${UNTRACKED_FILE}"}')
`,
  );
}

export function prependPath(dir: string): string {
  return `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

export function restrictedPath(names: readonly string[]): string {
  const dir = tempDir("rpath");
  for (const name of names) {
    const r = spawnSync("sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" });
    const resolved = r.stdout.trim();
    if (resolved.length === 0) continue;
    symlinkSync(resolved, join(dir, name));
  }
  return dir;
}

export function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `runhub-${tag}-`));
}

export function writeProjectsToml(configHome: string, name: string, projectPath: string, extra = ""): void {
  mkdirSync(join(configHome, "runhub"), { recursive: true });
  writeFileSync(join(configHome, "runhub", "projects.toml"), `[${name}]\npath = "${projectPath}"\n${extra}`);
}

export function withEnv(fn: () => Promise<void>): Promise<void> {
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevPath = process.env.PATH;
  process.env.XDG_DATA_HOME = tempDir("xdg");
  return fn().finally(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });
}
