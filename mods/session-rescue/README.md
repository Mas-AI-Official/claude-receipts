# Session Rescue

Claude Code mod. It keeps a crash-safe, redacted checkpoint of what the session did: your requests, every shell command with its real outcome, and the files changed. When a session dies mid-job or ends with work nobody tested, the next session in the same folder shows it above the prompt and can hand it to Claude. It never reruns anything. No model calls.

## What you see

- A band above the prompt when an earlier session left work behind: `RESCUE INTERRUPTED work from 2h ago, 3 file(s): /rescue`.
- `/rescue` shows the checkpoint: first and last request, files changed, and each command marked `ok`, `FAILED`, `INTERRUPTED` or `IN FLIGHT`, with the verdict:
  - `INTERRUPTED`: something was cut off, timed out, left in the background or still running when the session died.
  - `UNVERIFIED`: files changed after the last passing test, or no test ran.
  - `VERIFIED`: a test passed after the last change. Verified work is not offered.
- `/rescue load` gives the checkpoint to Claude as a record, not as instructions. Unfinished steps are labelled not done.
- `/rescue allow <n>`: a loaded checkpoint holds every destructive command that did not finish (`rm -rf`, `git push`, `git reset --hard`, SQL drops, deploys, publishes, outbound POSTs, send-mail scripts). Claude cannot run that exact command again until you allow its number.
- `/rescue dismiss` forgets it. `/rescue status` shows this session's own checkpoint.

## Where it writes

`~/.claude/mods-data/masai/session-rescue/<session id>.a.json` and `.b.json`. The two files alternate and each carries a checksum, so a crash in the middle of a write leaves the other file, one step older, readable. Commands and requests are redacted (tokens, keys, passwords, URL credentials) before they are written.

## Install

```bash
claude plugin marketplace add Mas-AI-Official/claude-receipts
```

```bash
claude plugin install session-rescue@claude-receipts
```

## Disable and roll back

- Everywhere: `claude plugin disable session-rescue@claude-receipts`.
- Remove: `claude plugin uninstall session-rescue@claude-receipts`, then delete `~/.claude/mods-data/masai/session-rescue/` if you do not want the checkpoints.
- The mod changes no settings or files of yours, so disabling it is the whole rollback.

## Verify

```bash
claude plugin validate mods/session-rescue
```

```bash
claude plugin test mods/session-rescue
```
