import { CLAUDE_MODEL, CURSOR_MODEL, assertNever, type AgentKind } from "./domain.js";

export const CLAUDE_CODE_IDS = ["fable", "sonnet", "opus", "haiku"] as const;
export type ClaudeCodeId = (typeof CLAUDE_CODE_IDS)[number];

const ALIAS_TO_ID: Record<string, ClaudeCodeId> = {
  fable: "fable",
  "fable-5": "fable",
  "fable-5-1": "fable",
  "claude-fable": "fable",
  "claude-fable-5": "fable",
  "claude-fable-5-1": "fable",
  sonnet: "sonnet",
  "claude-sonnet": "sonnet",
  opus: "opus",
  "claude-opus": "opus",
  haiku: "haiku",
  "claude-haiku": "haiku",
};

export function normalizeModelKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function suggestClaudeModelId(normalized: string): ClaudeCodeId {
  for (const id of CLAUDE_CODE_IDS) {
    if (normalized.includes(id)) return id;
  }
  for (const [alias, id] of Object.entries(ALIAS_TO_ID)) {
    if (alias.length >= 4 && (normalized.includes(alias) || alias.includes(normalized))) return id;
  }
  return CLAUDE_MODEL as ClaudeCodeId;
}

export function unrecognizedClaudeModelMessage(raw: string, normalized = normalizeModelKey(raw)): string {
  const suggested = suggestClaudeModelId(normalized);
  return `unrecognized --model '${raw}'. Try: --model ${suggested}`;
}

export function resolveClaudeModel(raw: string): ClaudeCodeId {
  const key = normalizeModelKey(raw);
  const mapped = ALIAS_TO_ID[key];
  if (mapped !== undefined) return mapped;
  throw new Error(unrecognizedClaudeModelMessage(raw, key));
}

export function claudeModelResolves(raw: string): boolean {
  const key = normalizeModelKey(raw);
  return ALIAS_TO_ID[key] !== undefined;
}

export function resolveAgentModel(agent: AgentKind, raw: string | undefined): string {
  switch (agent) {
    case "cursor":
      return raw === undefined || raw.trim() === "" ? CURSOR_MODEL : raw.trim();
    case "claude":
      return resolveClaudeModel(raw === undefined || raw.trim() === "" ? CLAUDE_MODEL : raw);
    default:
      return assertNever(agent);
  }
}
