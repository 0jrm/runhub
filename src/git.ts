import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ParseError, SPAWN_MAX_BUFFER, type DiffRange } from "./domain.js";

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

function git(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
  extraEnv?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: SPAWN_MAX_BUFFER,
    ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
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

export type GitIdentity = { name: string; email: string };

export function identityTomlPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "runhub", "identity.toml");
}

function nonemptyEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parseTomlScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end === -1) throw new ParseError("unterminated quoted value");
    const after = s.slice(end + 1).trim();
    if (after.length > 0 && !after.startsWith("#")) {
      throw new ParseError("trailing garbage after quoted value");
    }
    return s.slice(1, end);
  }
  const token = s.match(/^([^\s#]+)/);
  if (token?.[1] === undefined) throw new ParseError("missing value");
  return token[1];
}

export function parseIdentityToml(text: string): { name?: string; email?: string } {
  let name: string | undefined;
  let email: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      throw new ParseError(`identity.toml tables are not supported: ${trimmed}`);
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) throw new ParseError(`invalid line: ${trimmed}`);
    const key = trimmed.slice(0, eq).trim();
    const value = parseTomlScalar(trimmed.slice(eq + 1));
    if (key === "name") name = value;
    else if (key === "email") email = value;
  }
  return {
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    ...(email !== undefined && email.length > 0 ? { email } : {}),
  };
}

function identityFromFile(): { name?: string; email?: string } {
  const path = identityTomlPath();
  if (!existsSync(path)) return {};
  return parseIdentityToml(readFileSync(path, "utf8"));
}

/** RUNHUB_GIT_NAME/EMAIL, then identity.toml. Never git config --global. Fails naming the toml path. */
export function resolveGitIdentity(): GitIdentity {
  const file = identityFromFile();
  const name = nonemptyEnv("RUNHUB_GIT_NAME") ?? file.name;
  const email = nonemptyEnv("RUNHUB_GIT_EMAIL") ?? file.email;
  if (name !== undefined && email !== undefined) return { name, email };
  throw new Error(`missing git identity (name and email): ${identityTomlPath()}`);
}

export function gitIdentityEnv(id: GitIdentity = resolveGitIdentity()): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}

/** Write user.name/email only to this worktree's config.worktree. Does not touch shared .git/config or --global. */
export function ensureLocalGitIdentity(cwd: string): GitIdentity {
  const id = resolveGitIdentity();
  const dir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (dir.status !== 0) {
    throw new Error(`git rev-parse --absolute-git-dir failed: ${dir.stderr.trim() || dir.stdout.trim()}`);
  }
  const gitDir = dir.stdout.trim();
  if (gitDir.length === 0) throw new Error("git rev-parse --absolute-git-dir was empty");
  const file = join(gitDir, "config.worktree");
  for (const [key, value] of [
    ["user.name", id.name],
    ["user.email", id.email],
  ] as const) {
    const r = git(cwd, ["config", "--file", file, key, value]);
    if (r.status !== 0) {
      throw new Error(`git config --file ${file} ${key} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
  return id;
}

export function addDetachedWorktree(opts: { repo: string; tree: string; sha: string }): void {
  const r = git(opts.repo, ["worktree", "add", "--detach", opts.tree, opts.sha]);
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  linkIgnoredDeps(opts.repo, opts.tree);
  ensureLocalGitIdentity(opts.tree);
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
  ensureLocalGitIdentity(opts.tree);
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
  const id = ensureLocalGitIdentity(wt.tree);
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
  const commit = git(
    wt.tree,
    ["commit", "-q", "-m", commitMessage(prompt), "--"],
    30_000,
    gitIdentityEnv(id),
  );
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  return { didCommit: true, sha: revParseHead(wt.tree), porcelain };
}

export function diffText(cwd: string, range: DiffRange): string {
  return gitText(cwd, ["diff", `${range.from}..${range.to}`]);
}

export function logOnelineText(cwd: string, range: DiffRange, maxLines = 20): string {
  const text = gitText(cwd, ["log", "--oneline", `${range.from}..${range.to}`]);
  if (text.length === 0) return "";
  return text.split("\n").filter((line) => line.length > 0).slice(0, maxLines).join("\n");
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
