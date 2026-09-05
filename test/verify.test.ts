import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectTestCmd } from "../src/verify.js";

test("detectTestCmd follows package.json then pyproject then Makefile", () => {
  const root = mkdtempSync(join(tmpdir(), "runhub-detect-"));
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "Makefile"), "test:\n\ttrue\n");
  assert.equal(detectTestCmd(root), "make test");
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname='x'\n");
  assert.equal(detectTestCmd(root), "pytest");
  writeFileSync(join(root, "package.json"), "{}\n");
  assert.equal(detectTestCmd(root), "npm test");
  assert.equal(detectTestCmd(root, "pytest -q"), "pytest -q");
});
