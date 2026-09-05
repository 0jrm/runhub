import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SPAWN_MAX_BUFFER, type DiffRange } from "./domain.js";

export const IGNORED_DEP_NAMES = ["node_modules", ".venv", "venv", "target", ".tox"] as const;

export type RunWorktree = {
  readonly repo: string;
  readonly tree: string;
  readonly branch: string;
  readonly base: string;
};

export type LandResult =
  | { didCommit: true; sha: string; porcelain: string }
  | { didCommit: false; sha: string; porcelain: string };

function git(cwd: string, args: string[], timeoutMs = 30_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
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

function isIgnored(cwd: string, name: string): boolean {
  return git(cwd, ["check-ignore", "-q", "--", name]).status === 0;
}

function linkIgnoredDeps(repo: string, tree: string): void {
  for (const name of IGNORED_DEP_NAMES) {
    const src = join(repo, name);
    if (!existsSync(src)) continue;
    if (!isIgnored(repo, name)) continue;
    const dest = join(tree, name);
    if (existsSync(dest)) continue;
    try {
      symlinkSync(src, dest);
    } catch {
      continue;
    }
  }
}

export function addDetachedWorktree(opts: { repo: string; tree: string; sha: string }): void {
  const r = git(opts.repo, ["worktree", "add", "--detach", opts.tree, opts.sha]);
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  linkIgnoredDeps(opts.repo, opts.tree);
}

export function removeWorktree(opts: { repo: string; tree: string }): void {
  git(opts.repo, ["worktree", "remove", "--force", opts.tree]);
  git(opts.repo, ["worktree", "prune"]);
}

export function createRunWorktree(opts: { repo: string; tree: string; branch: string }): RunWorktree {
  const base = revParseHead(opts.repo);
  const r = git(opts.repo, ["worktree", "add", opts.tree, "-b", opts.branch, base]);
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  linkIgnoredDeps(opts.repo, opts.tree);
  return { repo: opts.repo, tree: opts.tree, branch: opts.branch, base };
}

export function removeRunWorktree(opts: { repo: string; tree: string; branch: string }): void {
  git(opts.repo, ["worktree", "remove", "--force", opts.tree]);
  git(opts.repo, ["worktree", "prune"]);
  git(opts.repo, ["branch", "-D", opts.branch]);
}

export function commitMessage(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  return `runhub: ${collapsed.slice(0, 60)}`;
}

export function landDirtyWork(wt: RunWorktree, prompt: string): LandResult {
  const porcelain = gitText(wt.tree, ["status", "--porcelain"]);
  if (porcelain.trim().length === 0) {
    return { didCommit: false, sha: revParseHead(wt.tree), porcelain };
  }
  // git add rejects an exclude pathspec that names a gitignored path, and skips those paths anyway
  const excludes = IGNORED_DEP_NAMES.filter((name) => !isIgnored(wt.tree, name)).map(
    (name) => `:(exclude)${name}`,
  );
  const add = git(wt.tree, ["add", "-A", "--", ".", ...excludes]);
  if (add.status !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const commit = git(wt.tree, ["commit", "-q", "-m", commitMessage(prompt), "--"]);
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  return { didCommit: true, sha: revParseHead(wt.tree), porcelain };
}

export function diffText(cwd: string, range: DiffRange): string {
  return gitText(cwd, ["diff", `${range.from}..${range.to}`]);
}

export function diffStatText(cwd: string, range: DiffRange): string {
  return gitText(cwd, ["diff", "--stat", `${range.from}..${range.to}`]);
}

export function remoteUrl(cwd: string, remote: string): string | undefined {
  const r = git(cwd, ["remote", "get-url", remote]);
  if (r.status !== 0) return undefined;
  const url = r.stdout.trim();
  return url.length > 0 ? url : undefined;
}

export function pushBranch(cwd: string, remote: string, branch: string): { status: number; text: string } {
  const r = git(cwd, ["push", "-u", remote, branch], 120_000);
  return { status: r.status, text: `${r.stdout}${r.stderr}`.trimEnd() };
}
