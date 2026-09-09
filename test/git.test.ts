import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  createRunWorktree,
  ensureLocalGitIdentity,
  identityTomlPath,
  landDirtyWork,
  resolveGitIdentity,
} from "../src/git.js";
import { prepareRun } from "../src/pipeline.js";
import { TRACKED_FILE, gitRepo, porcelainOf, tempDir, writeIdentityToml } from "./helpers.js";

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

function withIsolatedIdentity(fn: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "runhub-git-home-"));
  const cfg = mkdtempSync(join(tmpdir(), "runhub-git-cfg-"));
  const prevHome = process.env.HOME;
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const prevName = process.env.RUNHUB_GIT_NAME;
  const prevEmail = process.env.RUNHUB_GIT_EMAIL;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.RUNHUB_GIT_NAME;
  delete process.env.RUNHUB_GIT_EMAIL;
  try {
    fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevCfg;
    if (prevName === undefined) delete process.env.RUNHUB_GIT_NAME;
    else process.env.RUNHUB_GIT_NAME = prevName;
    if (prevEmail === undefined) delete process.env.RUNHUB_GIT_EMAIL;
    else process.env.RUNHUB_GIT_EMAIL = prevEmail;
    delete process.env.GIT_CONFIG_NOSYSTEM;
  }
}

test("createRunWorktree does not write the shared repo .git/config", () => {
  withIsolatedIdentity(() => {
    process.env.RUNHUB_GIT_NAME = "runhub-test";
    process.env.RUNHUB_GIT_EMAIL = "runhub-test@localhost";
    const home = process.env.HOME ?? "";
    const env = isolatedGitEnv(home);
    const repo = tempDir("git-noid-repo");
    const tree = join(tempDir("git-noid-parent"), "tree");
    repoWithoutIdentity(repo, env);
    const sharedConfig = join(repo, ".git", "config");
    const before = readFileSync(sharedConfig, "utf8");
    createRunWorktree({ repo, tree, branch: "runhub/git-identity" });
    assert.equal(readFileSync(sharedConfig, "utf8"), before);
    assert.notEqual(git(repo, ["config", "--local", "--get", "user.name"], env).status, 0);
    assert.notEqual(git(tree, ["config", "--local", "--get", "user.name"], env).status, 0);
    const gitDir = git(tree, ["rev-parse", "--absolute-git-dir"], env).stdout.trim();
    const wtName = git(tree, ["config", "--file", join(gitDir, "config.worktree"), "--get", "user.name"], env);
    const wtEmail = git(tree, ["config", "--file", join(gitDir, "config.worktree"), "--get", "user.email"], env);
    assert.equal(wtName.stdout.trim(), "runhub-test");
    assert.equal(wtEmail.stdout.trim(), "runhub-test@localhost");
    const globalName = git(tree, ["config", "--global", "--get", "user.name"], env);
    assert.notEqual(globalName.status, 0);

    writeFileSync(join(tree, TRACKED_FILE), "edited\n");
    const landed = landDirtyWork({ repo, tree, branch: "runhub/git-identity", base: "unused" }, "commit me");
    assert.equal(landed.didCommit, true);
    assert.equal(porcelainOf(tree).trim(), "");
    const author = spawnSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: tree,
      encoding: "utf8",
      env,
    }).stdout.trim();
    assert.equal(author, "runhub-test <runhub-test@localhost>");
    assert.equal(readFileSync(sharedConfig, "utf8"), before);
  });
});

test("identity.toml supplies name and email when env is unset", () => {
  withIsolatedIdentity(() => {
    const cfg = process.env.XDG_CONFIG_HOME ?? "";
    writeIdentityToml(cfg);
    const id = resolveGitIdentity();
    assert.equal(id.name, "Testy the bot");
    assert.equal(id.email, "testy@users.noreply.github.com");
  });
});

test("RUNHUB_GIT_NAME and RUNHUB_GIT_EMAIL override identity.toml", () => {
  withIsolatedIdentity(() => {
    writeIdentityToml(process.env.XDG_CONFIG_HOME ?? "");
    process.env.RUNHUB_GIT_NAME = "Env Bot";
    process.env.RUNHUB_GIT_EMAIL = "env@localhost";
    const id = resolveGitIdentity();
    assert.equal(id.name, "Env Bot");
    assert.equal(id.email, "env@localhost");
  });
});

test("missing identity fails fast before a run dir is created and names the toml path", () => {
  withIsolatedIdentity(() => {
    const path = identityTomlPath();
    assert.throws(() => resolveGitIdentity(), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /missing git identity \(name and email\)/);
      assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
    const work = tempDir("git-noid-prepare");
    gitRepo(work);
    assert.throws(() => prepareRun({ cwd: work, prompt: "nope" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /missing git identity \(name and email\)/);
      assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  });
});

test("ensureLocalGitIdentity on a normal repo still leaves .git/config without user.name", () => {
  withIsolatedIdentity(() => {
    process.env.RUNHUB_GIT_NAME = "runhub";
    process.env.RUNHUB_GIT_EMAIL = "runhub@localhost";
    const home = process.env.HOME ?? "";
    const env = isolatedGitEnv(home);
    const repo = tempDir("git-bare-repo");
    repoWithoutIdentity(repo, env);
    writeFileSync(join(repo, TRACKED_FILE), "edited\n");
    git(repo, ["add", "."], env);
    const commit = spawnSync("git", ["commit", "-q", "-m", "no identity"], { cwd: repo, encoding: "utf8", env });
    assert.notEqual(commit.status, 0);
    assert.match(`${commit.stdout}${commit.stderr}`, /Author identity unknown|tell me who you are/i);
    const before = readFileSync(join(repo, ".git", "config"), "utf8");
    ensureLocalGitIdentity(repo);
    assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), before);
    assert.notEqual(git(repo, ["config", "--local", "--get", "user.name"], env).status, 0);
  });
});

test("gitRepo helper still seeds identity for other tests", () => {
  const dir = tempDir("git-helper");
  gitRepo(dir);
  const name = spawnSync("git", ["config", "--get", "user.name"], { cwd: dir, encoding: "utf8" });
  assert.equal(name.stdout.trim(), "t");
});
