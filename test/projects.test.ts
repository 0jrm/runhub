import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ParseError } from "../src/domain.js";
import { loadProjects, parseProjects, resolveRunCwd } from "../src/projects.js";
import { tempDir } from "./helpers.js";

test("parseProjects reads tables, quoted test, comments, and blanks", () => {
  const projects = parseProjects(`
# a comment

[hycom]
path = /tmp/hycom
test = "cd packages/markitdown && hatch test"

[runhub]
path = "/tmp/runhub"
`);
  assert.deepEqual(projects, [
    { name: "hycom", path: "/tmp/hycom", test: "cd packages/markitdown && hatch test" },
    { name: "runhub", path: "/tmp/runhub" },
  ]);
});

test("parseProjects reads typecheck, lint, and remote keys", () => {
  const projects = parseProjects(`[hycom]
path = /tmp/hycom
test = true
typecheck = mypy
lint = "ruff check"
remote = origin
`);
  assert.deepEqual(projects, [
    {
      name: "hycom",
      path: "/tmp/hycom",
      test: "true",
      typecheck: "mypy",
      lint: "ruff check",
      remote: "origin",
    },
  ]);
});

test("parseProjects reads sandbox", () => {
  const projects = parseProjects(`[hycom]
path = /tmp/hycom
sandbox = none
`);
  assert.deepEqual(projects, [{ name: "hycom", path: "/tmp/hycom", sandbox: "none" }]);
});

test("parseProjects throws on a table with no path or on garbage", () => {
  assert.throws(() => parseProjects("[hycom]\ntest = true\n"), ParseError);
  assert.throws(() => parseProjects("not a toml line\n"), ParseError);
  assert.throws(() => parseProjects("path = /tmp/x\n"), ParseError);
  assert.throws(() => parseProjects('[hycom]\npath = "/tmp/x\n'), ParseError);
  assert.throws(() => parseProjects("[hycom]\npath = /tmp/a\n[hycom]\npath = /tmp/b\n"), ParseError);
});

test("loadProjects returns an empty list when the file is missing", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir("cfg-missing"), "nope");
  try {
    assert.deepEqual(loadProjects(), []);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("loadProjects reads projects.toml under XDG_CONFIG_HOME", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  const xdg = tempDir("cfg-present");
  mkdirSync(join(xdg, "runhub"), { recursive: true });
  writeFileSync(join(xdg, "runhub", "projects.toml"), "[toy]\npath = /tmp/toy\ntest = true\n");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    assert.deepEqual(loadProjects(), [{ name: "toy", path: "/tmp/toy", test: "true" }]);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("resolveRunCwd matches a project name, then a realpath, else resolve(raw)", () => {
  const dir = tempDir("proj-cwd");
  const parent = tempDir("proj-linkp");
  const link = join(parent, "link");
  symlinkSync(dir, link);
  const projects = [{ name: "toy", path: dir, test: "true", sandbox: "none" as const }];
  assert.deepEqual(resolveRunCwd("toy", projects), { cwd: resolve(dir), test: "true", sandbox: "none" });
  assert.deepEqual(resolveRunCwd(dir, projects), { cwd: resolve(dir), test: "true", sandbox: "none" });
  assert.deepEqual(resolveRunCwd(link, projects), { cwd: resolve(link), test: "true", sandbox: "none" });
  assert.deepEqual(resolveRunCwd("other", projects), { cwd: resolve("other"), sandbox: "none" });
  assert.deepEqual(resolveRunCwd("toy", [{ name: "toy", path: dir, sandbox: "none" }]), {
    cwd: resolve(dir),
    sandbox: "none",
  });
  assert.deepEqual(
    resolveRunCwd("toy", [
      { name: "toy", path: dir, typecheck: "mypy", lint: "ruff check", remote: "origin", sandbox: "none" },
    ]),
    {
      cwd: resolve(dir),
      typecheck: "mypy",
      lint: "ruff check",
      remote: "origin",
      sandbox: "none",
    },
  );
});
