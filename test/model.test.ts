import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_MODEL, CURSOR_MODEL } from "../src/domain.js";
import {
  claudeModelResolves,
  normalizeModelKey,
  resolveAgentModel,
  resolveClaudeModel,
  suggestClaudeModelId,
  unrecognizedClaudeModelMessage,
} from "../src/model.js";

test("normalizeModelKey turns spaces underscores and dots into hyphens", () => {
  assert.equal(normalizeModelKey("fable 5.1"), "fable-5-1");
  assert.equal(normalizeModelKey("fable-5.1"), "fable-5-1");
  assert.equal(normalizeModelKey("fable_5_1"), "fable-5-1");
  assert.equal(normalizeModelKey("  Fable  "), "fable");
});

test("resolveClaudeModel maps fable aliases to the Claude Code short id", () => {
  assert.equal(resolveClaudeModel("fable"), "fable");
  assert.equal(resolveClaudeModel("fable 5.1"), "fable");
  assert.equal(resolveClaudeModel("fable-5.1"), "fable");
  assert.equal(resolveClaudeModel("claude-fable-5-1"), "fable");
  assert.equal(resolveClaudeModel("sonnet"), "sonnet");
  assert.equal(resolveClaudeModel(CLAUDE_MODEL), "sonnet");
});

test("unknown Claude model fails with a --model suggestion and does not pick opus vs sonnet", () => {
  assert.throws(
    () => resolveClaudeModel("not-a-real-model"),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /unrecognized --model 'not-a-real-model'/);
      assert.match(message, /Try: --model sonnet/);
      assert.doesNotMatch(message, /opus or sonnet|sonnet vs opus|pick/i);
      return true;
    },
  );
  assert.equal(suggestClaudeModelId(normalizeModelKey("fable-xx")), "fable");
  assert.equal(unrecognizedClaudeModelMessage("fable-xx"), "unrecognized --model 'fable-xx'. Try: --model fable");
  assert.equal(claudeModelResolves("sonnet"), true);
  assert.equal(claudeModelResolves("banana"), false);
});

test("resolveAgentModel leaves cursor ids alone and defaults Claude to sonnet", () => {
  assert.equal(resolveAgentModel("cursor", undefined), CURSOR_MODEL);
  assert.equal(resolveAgentModel("cursor", "some-cursor-id"), "some-cursor-id");
  assert.equal(resolveAgentModel("claude", undefined), "sonnet");
  assert.equal(resolveAgentModel("claude", "fable 5.1"), "fable");
});
