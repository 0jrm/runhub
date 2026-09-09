import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createRunWorktree, ensureLocalGitIdentity, landDirtyWork } from "../src/git.js";
import { TRACKED_FILE, gitRepo, porcelainOf, tempDir } from "./helpers.js";

function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.EMAIL;
  return env;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function repoWithoutIdentity(dir: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(dir, { recursive: true });
  const init = git(dir, ["init", "-q"], env);
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(dir, TRACKED_FILE), "x\n");
  git(dir, ["add", "."], env);
  const commit = spawnSync(
    "git",
    ["-c", "user.name=bootstrap", "-c", "user.email=boot@localhost", "commit", "-q", "-m", "init"],
    { cwd: dir, encoding: "utf8", env },
  );
  assert.equal(commit.status, 0, commit.stderr);
  assert.notEqual(git(dir, ["config", "--local", "--get", "user.name"], env).status, 0);
}

test("ensureLocalGitIdentity sets worktree-local name and email when git has none", () => {
  const home = mkdtempSync(join(tmpdir(), "runhub-git-home-"));
  const env = isolatedGitEnv(home);
  const prevHome = process.env.HOME;
  const prevName = process.env.RUNHUB_GIT_NAME;
  const prevEmail = process.env.RUNHUB_GIT_EMAIL;
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.GIT_CONFIG_GLOBAL;
  process.env.RUNHUB_GIT_NAME = "runhub-test";
  process.env.RUNHUB_GIT_EMAIL = "runhub-test@localhost";
  const repo = tempDir("git-noid-repo");
  const tree = join(tempDir("git-noid-parent"), "tree");
  try {
    repoWithoutIdentity(repo, env);
    createRunWorktree({ repo, tree, branch: "runhub/git-identity" });
    const name = git(tree, ["config", "--get", "user.name"], env);
    const email = git(tree, ["config", "--get", "user.email"], env);
    assert.equal(name.stdout.trim(), "runhub-test");
    assert.equal(email.stdout.trim(), "runhub-test@localhost");
    const globalName = git(tree, ["config", "--global", "--get", "user.name"], env);
    assert.notEqual(globalName.status, 0);

    writeFileSync(join(tree, TRACKED_FILE), "edited\n");
    const landed = landDirtyWork({ repo, tree, branch: "runhub/git-identity", base: "unused" }, "commit me");
    assert.equal(landed.didCommit, true);
    assert.equal(porcelainOf(tree).trim(), "");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevName === undefined) delete process.env.RUNHUB_GIT_NAME;
    else process.env.RUNHUB_GIT_NAME = prevName;
    if (prevEmail === undefined) delete process.env.RUNHUB_GIT_EMAIL;
    else process.env.RUNHUB_GIT_EMAIL = prevEmail;
    delete process.env.GIT_CONFIG_NOSYSTEM;
  }
});

test("landDirtyWork on a repo with no identity fails without ensureLocalGitIdentity", () => {
  const home = mkdtempSync(join(tmpdir(), "runhub-git-bare-"));
  const env = isolatedGitEnv(home);
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.RUNHUB_GIT_NAME;
  delete process.env.RUNHUB_GIT_EMAIL;
  try {
    const repo = tempDir("git-bare-repo");
    repoWithoutIdentity(repo, env);
    writeFileSync(join(repo, TRACKED_FILE), "edited\n");
    git(repo, ["add", "."], env);
    const commit = spawnSync("git", ["commit", "-q", "-m", "no identity"], { cwd: repo, encoding: "utf8", env });
    assert.notEqual(commit.status, 0);
    assert.match(`${commit.stdout}${commit.stderr}`, /Author identity unknown|tell me who you are/i);
    ensureLocalGitIdentity(repo);
    const retry = spawnSync("git", ["commit", "-q", "-m", "with identity"], { cwd: repo, encoding: "utf8", env });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(git(repo, ["config", "--get", "user.name"], env).stdout.trim(), "runhub");
    assert.equal(git(repo, ["config", "--get", "user.email"], env).stdout.trim(), "runhub@localhost");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.GIT_CONFIG_NOSYSTEM;
  }
});

test("gitRepo helper still seeds identity for other tests", () => {
  const dir = tempDir("git-helper");
  gitRepo(dir);
  const name = spawnSync("git", ["config", "--get", "user.name"], { cwd: dir, encoding: "utf8" });
  assert.equal(name.stdout.trim(), "t");
});
