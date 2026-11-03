# claude-receipts

**Claude Code mods that make your agent show receipts.**

Your coding agent says "all tests pass". Did they? Did they run at all, or did a `| tail` swallow the exit code? Did a file change after the run? And when a session crashes in the middle of a deploy, what was finished and what was not?

These mods answer that from evidence, not from the model's word. They add no model calls and no prompt text unless they have to stop something.

| Mod | Command | What it does |
|---|---|---|
| **Test Truth Gate** | `/qa` | Records the real result of every test, API check and ffmpeg render. Marks a result stale the moment a file changes after it. If Claude's final reply claims success that the evidence does not hold, the turn is sent back with the exact failing or stale run. |
| **Session Rescue** | `/rescue` | Keeps a crash-safe, redacted checkpoint of the session's work. The next session in the folder sees what was interrupted, what failed and what was never tested. It never reruns anything, and it holds unfinished destructive commands (`git push`, `rm -rf`, deploys, SQL drops) until you allow each one. |

## It caught its own author

While these mods were being built, Claude ran the checks in one piped command and replied that everything passed. Test Truth Gate sent the turn back:

```
Test Truth Gate: your reply claims a verified pass, but the evidence does not hold it:
- `node ".../tsc" -p . 2>&1 | head -5; node --test tests…` is incomplete
  (exit code masked (pipe, || true, or a later command) and no pass summary in the output)
Rerun the verification in the foreground and report its real result, or restate the reply
as NOT VERIFIED and name the check that was not run.
```

Claude reran each check on its own and reported what actually ran. That is the whole point.

## Install

Inside Claude Code:

```
/plugin marketplace add Mas-AI-Official/claude-receipts
/plugin install test-truth-gate@claude-receipts
/plugin install session-rescue@claude-receipts
```

Or from a terminal:

```bash
claude plugin marketplace add Mas-AI-Official/claude-receipts
```

```bash
claude plugin install test-truth-gate@claude-receipts
```

Each mod installs on its own. Disable one with `claude plugin disable <mod>@claude-receipts`.

## What counts as evidence

Test Truth Gate reads the command the agent actually ran and its real result:

- **Runners it knows:** pytest, unittest, npm/pnpm/yarn/bun test, vitest, jest, mocha, `node --test`, newman, `curl --fail` API checks, ffmpeg renders (the output file must exist and be non-empty), `claude plugin test`.
- **Not evidence:** a `grep pytest`, an `echo "tests pass"`, `--collect-only`, `--help`, a run that collected 0 tests, a run interrupted or sent to the background, a pipe or `|| true` that hides the exit code with no pass count in the output.
- **Stale:** an edit, a `git checkout`, an `npm install`, or any change to the git working tree after the run.
- **Honest replies pass:** "NOT VERIFIED: the API test was not run" is never blocked.

It blocks at most twice per turn, then steps aside with a warning, so it cannot trap a session in a loop. `/qa off` turns it off for the session.

## Safety

- Commands, requests and summaries are redacted before they are written (auth headers, bearer tokens, common key shapes, `--password` flags, `*_KEY=` assignments, URL credentials).
- Data stays on your machine under `~/.claude/mods-data/masai/`. No network calls.
- A rescued checkpoint reaches Claude as a record wrapped in a notice that it is not instructions from you.

## Develop

```bash
node --test tests/*.spec.ts
```

```bash
claude plugin validate mods/test-truth-gate
```

```bash
claude plugin test mods/test-truth-gate
```

Shared code lives in `shared/`; run `node scripts/sync-shared.ts` after editing it (a test fails if a mod's copy drifts).

## Credits

- Built on the Claude Code mods API: [code.claude.com/docs/en/plugins/mods](https://code.claude.com/docs/en/plugins/mods/create).
- Inspired by [nateherkai/claude-code-mods](https://github.com/nateherkai/claude-code-mods).

Made by [MAS-AI Technologies](https://mas-ai.co). MIT licence. Issues and pull requests are welcome.
