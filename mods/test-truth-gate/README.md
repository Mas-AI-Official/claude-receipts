# Test Truth Gate

Claude Code mod. It records the real result of every test, API check and render the session runs, marks a result stale when a file changes after it, and sends the turn back when the final reply claims success that the evidence does not hold. No model calls; zero added tokens unless it blocks.

## What you see

- A band above the prompt once anything ran: `QA  PASS python 2m  FAIL api 30s  STALE js 5m`.
- `/qa` lists the newest run of each kind, the last file change and the evidence file path. `/qa off`, `/qa on`, `/qa clear`.
- When Claude says "all tests pass" after a failed, interrupted, background or stale run, it gets one short message naming the run and is asked to rerun it or say NOT VERIFIED. At most two returns per turn.

## Evidence

- Session file: `~/.claude/mods-data/masai/test-truth-gate/<session id>.json` (redacted commands and summaries).
- Verdict ledger (optional): set `MASAI_LEDGER_DIR` to a folder and each claim verdict appends one line to `aqa_verdicts.ndjson` there, `runtime: claude-code`.

## Install

```bash
claude plugin marketplace add Mas-AI-Official/claude-receipts
```

```bash
claude plugin install test-truth-gate@claude-receipts
```

Terminal sessions also load it from `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Desktop-app sessions ignore that value (the app supplies the variable itself), so on the desktop use the marketplace install.

## Disable and roll back

- For one session: `/qa off`.
- Everywhere: `claude plugin disable test-truth-gate@claude-receipts`.
- Remove: `claude plugin uninstall test-truth-gate@claude-receipts`. Evidence files stay under `~/.claude/mods-data/masai/test-truth-gate/` and can be kept as an audit record.
- The mod changes no settings, files or hooks of yours, so disabling it is the whole rollback.

## Verify

```bash
claude plugin validate mods/test-truth-gate
```

```bash
claude plugin test mods/test-truth-gate
```

```bash
node --test tests/test-truth-gate.core.spec.ts
```
