import { spawnSync } from "node:child_process";
import { SPAWN_MAX_BUFFER } from "./domain.js";

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function gitText(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  return `${r.stdout}${r.stderr}`.trimEnd();
}

export function revParseHead(cwd: string): string {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr.trim()}`);
  const sha = r.stdout.trim();
  if (sha.length === 0) throw new Error("git rev-parse HEAD was empty");
  return sha;
}

export function addRunWorktree(opts: { repo: string; tree: string; branch: string; base: string }): void {
  const r = git(opts.repo, ["worktree", "add", opts.tree, "-b", opts.branch, opts.base]);
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export function removeRunWorktree(opts: { repo: string; tree: string; branch: string }): void {
  git(opts.repo, ["worktree", "remove", "--force", opts.tree]);
  git(opts.repo, ["worktree", "prune"]);
  git(opts.repo, ["branch", "-D", opts.branch]);
}
