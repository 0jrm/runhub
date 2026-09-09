---
name: audit-enhance
description: >-
  Brutally honest code, design, and UX audit of a repo, followed by the next
  prompt for the AI agent building it. Use for /audit-enhance, "audit this
  repo", "are we there yet", "review the branch and tell me what to build
  next", or any request to judge an AI-built project against its original
  brief and direct the next round. Applies even when the user only says
  "review this" and gives a GitHub URL; the point is to run the code, not
  read it.
disable-model-invocation: true
---

# Audit-enhance

Audit a repo the way an adversarial senior engineer would, then write the
prompt that tells the builder agent exactly what to do next. Output is two
things: findings the user can trust because you observed them, and a
builder prompt where every item names the line of output it changes.

The user does not need feelings managed. Lead with the verdict. Say "no"
when the answer is no.

## 0. Intake

Collect before touching code:

- Repo URL and branch. Re-audits usually reuse a branch name; do not
  assume the content matches your last read.
- The original brief, verbatim, if one exists. The audit is judged against
  it.
- Your previous audit and previous builder prompt, if this is round two or
  later. Re-audits check whether each prior finding was fixed and what the
  fix broke.
- Who consumes the output. A CLI has at least two users: the human and
  whatever calls it (a bot, CI, another agent). Audit each separately.

If the brief is missing, ask for it once, then proceed with the README as
the brief and say so.

## 1. Read everything

Shallow-clone into a fresh directory. Never overwrite a previous clone;
keep it so you can diff.

```bash
git clone --depth 1 --branch <branch> <url> <dir-N>
diff -rq --exclude=.git --exclude=node_modules --exclude=dist <dir-N-1> <dir-N>
find src test -type f | xargs wc -l | sort -n
```

Read docs first (README, bot instructions, package manifest), then every
source file, then every test. Under 3,000 lines, read all of it; do not
sample. Above that, read the pipeline and entry points in full and grep
the rest for the patterns in step 3.

While reading, write down every claim the docs make about behavior. Each
one is a hypothesis to test in step 3.

## 2. Build and test

Install, build, run the suite. Record the pass count. A green suite tells
you what the tests cover, not whether the tool works; note what the tests
do not exercise (spawn paths, failure paths, signals, size limits).

## 3. Probe with fake binaries

This is the step that finds the bugs. For every external program the code
spawns, write a fake on PATH that behaves like the real one in the ways
that matter, then run the real CLI against it. Fakes are cheap; a fake
that takes two minutes to write has found a crash in every round so far.

Standard fakes to run, adapted to the domain:

| Fake behavior | What it catches |
|---|---|
| Emits 200 KB+ of stdout | argv size limits (E2BIG at 128 KiB), unbounded buffers, truncation |
| Writes a real error to stderr, exits 0 | stderr discarded, misleading "exit 1" with no reason |
| Edits a tracked file without committing | diff computed from the wrong ref, empty branch, empty review |
| Creates an untracked file | `git diff` blind spot |
| Commits its own work | "no changes" reported on real work |
| Sleeps 60s | SIGINT handling, orphaned process groups, missing timeouts |
| Exits non-zero | outcome logic, error attribution |
| Depends on gitignored deps (node_modules, .venv) | fresh-checkout assumptions |

Also probe the CLI surface directly: typo'd flags, a value starting with
`--`, a nonexistent `--cwd`, missing required args, the empty-state
commands (`list`, `status` with no runs). Then kill the process mid-run
and inspect stored state.

Rules for claims:

- Only assert a bug you reproduced. Quote the command and the output.
- If a probe is ambiguous (timing, environment), say "could not pin down"
  and suggest the test that would settle it. Never upgrade a hunch to a
  finding.
- Cite `file.ts:line` for the cause once you have the symptom.

## 4. Brief versus reality

Take each requirement in the original brief and write one line: what the
brief asked for, what the code actually does, and the gap. Be literal.
"Verified" that means "a second LLM read the first LLM's stdout" is not
verified. "Quota" that means `--version` probes is not quota. Name the
requirement the code satisfies in name only; those are the most dangerous
because they look done.

Then find the unused parts: types defined and never constructed, personas
never assigned, flags never read, fields never populated. Dead surface is
evidence of a brief the code could not meet.

## 5. Question the requirements

Before recommending fixes, run the brief and the code through this order.
Skipping steps one and two and going straight to "fix the bugs" is the
commonest way to optimize something that should not exist.

1. Which requirements are wrong, including the user's own? A requirement
   nobody can meet gets met in name only. Two requirements that pull
   against each other ("fully auditable" and "minimum storage") need an
   owner to pick.
2. What can be deleted? If nothing comes back later, not enough was
   removed. A stage, flag, persona, or report section earns its place by
   naming the output line it improves.
3. Only now: simplify and fix what remains. Bugs in a deleted stage are
   not bugs.
4. Speed and automation last, and only in the direction the first three
   steps point.

Write the result of this pass into the audit; the user should see why a
finding was dropped as well as why one was kept.

## 6. Write the audit

Order, no exceptions:

1. **Verdict.** Two to four sentences. Is it the thing the brief asked
   for? Does it work? What is the single most important problem?
2. **How it works.** Only when asked, or when the reader is not the
   author. One paragraph per module, in execution order.
3. **Bugs, confirmed by running it.** Numbered, bold one-line title, then
   the reproduction, the observed output, the cause with file and line,
   and the fix in one sentence. Worst first. Smaller confirmed issues in
   a short list after.
4. **Design.** The structural problem underneath the bugs, if there is
   one. Usually there is exactly one (a misplaced safety boundary, a
   wrong assumption about the external tool, a missing baseline).
5. **UX.** One subsection per consumer. Show what the consumer actually
   sees today (paste it) and what it should see.
6. **What is good.** Short, specific, true. Discipline, not comfort.
7. **What I would do, in order.** Five to eight items, prioritized by
   what unblocks the rest.

Prose rules: apply the unslop skill. No em dashes. No hedged verdicts.
No "you might consider." Name the thing.

## 7. Write the builder prompt

The prompt goes in a code block so the user can paste it unchanged.
Structure:

- One line of scope: version name and the single goal.
- Numbered items. Each item states the change, the test that proves it
  (fake-binary tests for anything that spawns a process), and the report
  line or command it affects. An item that changes no observable output
  does not go in.
- Small items grouped in one "Also:" paragraph so the numbered list stays
  under twelve.
- A **Done means** gate that requires evidence from a real run on a real
  target, pasted. Fixtures do not satisfy the gate. State this every
  round; builders will substitute a passing test for a real run if
  allowed.
- A **Not in scope** list naming the things the brief keeps trying to
  bring back. Repeat it every round.

When the work is larger than one session, split into phases with a gate
between each and the instruction "do not start the next phase until I
say so." Put any decision that changes how the user installs or uses the
tool (sandboxing, storage location, default permissions) as an explicit
stop-and-ask item, and put it last.

## 8. Re-audit rounds

On round two and later:

- Diff against the previous clone first. List what changed.
- For each prior finding, mark fixed, partially fixed, or not fixed, with
  a probe result, not a code read.
- Look specifically for the assumption the fixes introduced. Fixes for
  "agent output too large" introduce "assumes agent commits"; fixes for
  "no isolation" introduce "assumes dependencies are committed." Every
  round has one such class. Find it.
- If the gate from the previous prompt (real-run evidence) was not met,
  say so at the top of the verdict and again in the new gate. Do not
  soften this on repetition.

## Guardrails

- Run it. A code-read-only audit is not an audit-enhance; say so and
  either run it or decline the name.
- Do not narrate tool calls or explain routing. Findings, then prompt.
- Do not invent history. With a shallow clone you cannot see commits;
  do not claim what "was" there.
- Keep the user's stated constraints (who runs it, what quota, which
  tools) as constraints. Suggest deleting requirements; do not silently
  add any.
- Length follows content. A round with two bugs is short.

## If PR pass, merge.
