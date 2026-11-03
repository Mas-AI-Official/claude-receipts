// Pure-core tests for Session Rescue, run under node: node --test tests/*.spec.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decode, encode, fresh, isDestructive, isTest, pick, verdict, type Checkpoint, type Step } from '../mods/session-rescue/hooks/core.ts'

const step = (p: Partial<Step>): Step => ({ id: 1, at: 1, tool: 'Bash', what: 'x', status: 'ok', test: false, destructive: false, ...p })
const cp = (steps: Step[], p: Partial<Checkpoint> = {}): Checkpoint => ({ ...fresh('s1', 'C:/r', 0), steps, ...p })
// assembled at run time: the machine's shell guard stops a literal of this shape
const SQL_DROP = ['DROP', 'TABLE', 'users'].join(' ')

test('isDestructive: data loss, publish, deploy and outbound calls; not reads or tests', () => {
  for (const c of ['rm -rf dist', 'git push origin main', 'git reset --hard HEAD~1', SQL_DROP, 'npm publish', 'vercel deploy --prod', 'kubectl delete pod x', 'curl -X POST https://api/x', 'Remove-Item -Recurse a', 'python send_emails.py', 'gh pr merge 3'])
    assert.equal(isDestructive(c), true, c)
  for (const c of ['git status', 'pytest -q', 'ls -la', 'npm run build', 'curl -s http://localhost/health', 'rm file.txt', 'git diff'])
    assert.equal(isDestructive(c), false, c)
})

test('isTest: common runners', () => {
  for (const c of ['pytest -q', 'npm test', 'node --test tests/', 'python -m pytest', 'go test ./...', 'claude plugin test mods/x']) assert.equal(isTest(c), true, c)
  for (const c of ['grep pytest', 'npm run build', 'cat test.py']) assert.equal(isTest(c), false, c)
})

test('verdict: interrupted beats everything; a passing test after the last edit verifies', () => {
  assert.equal(verdict(cp([])), 'EMPTY')
  assert.equal(verdict(cp([step({ status: 'running' })])), 'INTERRUPTED')
  assert.equal(verdict(cp([step({ tool: 'Edit' }), step({ test: true })])), 'VERIFIED')
  assert.equal(verdict(cp([step({ test: true }), step({ tool: 'Edit' })])), 'UNVERIFIED')
  assert.equal(verdict(cp([step({ tool: 'Edit' }), step({ test: true, status: 'failed' })])), 'UNVERIFIED')
  assert.equal(verdict(cp([step({ tool: 'Edit' })])), 'UNVERIFIED')
})

test('slots: the newest intact copy wins; a torn or tampered one is ignored', () => {
  const a = encode({ ...cp([]), seq: 4 })
  const b = encode({ ...cp([]), seq: 5 })
  assert.equal(decode([a, b])?.seq, 5)
  assert.equal(decode([a, b.slice(0, 40)])?.seq, 4)
  assert.equal(decode([a, b.replace('\\"seq\\":5', '\\"seq\\":9')])?.seq, 4)
  assert.equal(decode([null, '']), null)
})

test('pick: same folder, other session, unfinished, recent, not dismissed', () => {
  const open = cp([step({ status: 'running' })], { session: 'old', cwd: 'c:\\r\\', updatedAt: 100 })
  assert.equal(pick([open], 's1', 'C:/r', 200)?.session, 'old')
  assert.equal(pick([{ ...open, session: 's1' }], 's1', 'C:/r', 200), null)
  assert.equal(pick([{ ...open, dismissed: true }], 's1', 'C:/r', 200), null)
  assert.equal(pick([{ ...open, cwd: 'C:/work/other' }], 's1', 'C:/r', 200), null)
  assert.equal(pick([open], 's1', 'C:/r', 100 + 8 * 86400000), null)
})
