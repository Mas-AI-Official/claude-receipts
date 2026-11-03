import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// The world beneath the mod: no git (process.run fails), a home folder, a clock.
function world(on: On, opts: { porcelain?: () => string; statMissing?: boolean; gitDirs?: string[] } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/test' })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('classic.Stop', () => ({}))
  on('command.register', () => ({ value: { command: 'qa' } }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git' && e.argv.includes('rev-parse')) opts.gitDirs?.push(e.argv[2] ?? '')
    if (!opts.porcelain || e.argv[0] !== 'git') return ran(128, '')
    if (e.argv.includes('rev-parse')) return ran(0, 'C:/repo\nabc123\n')
    return ran(0, opts.porcelain())
  })
  on('fs.stat', () => {
    if (opts.statMissing) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 10, mtimeMs: 5, isLink: false } }
  })
  return clock
}

// What the engine's Bash answers for a run
function bash(on: On, answer: (command: string) => object) {
  on('tool.call', (_: unknown, e: unknown) => answer((e as { command?: string }).command ?? '') as never)
}

const QA = { command: 'qa', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const PASS = { result: { stdout: '===== 12 passed in 0.4s =====', stderr: '', interrupted: false } }
const FAIL = { result: { stdout: '', stderr: '', interrupted: false }, isError: true, text: 'Exit code 1\n===== 1 failed, 11 passed in 0.5s =====' }

async function start($: Engine) {
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
}

async function stop($: Engine, message: string, active = false) {
  return $.classic.Stop({ stop_hook_active: active, last_assistant_message: message })
}

test('normal: a fresh pass holds a success claim', async ($, on) => {
  world(on)
  bash(on, () => PASS)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  const r = await stop($, 'All 12 tests pass.')
  expect(r.block).toBeUndefined()
})

test('failure: a failed run blocks a success claim and names the run', async ($, on) => {
  world(on)
  bash(on, () => FAIL)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  const r = await stop($, 'Done. All tests pass.')
  expect(r.block).toContain('FAILED')
  expect(r.block).toContain('pytest -q')
})

test('failure hidden by a pipe: exit 0 with failures in the output still blocks', async ($, on) => {
  world(on)
  bash(on, () => ({ result: { stdout: '1 failed, 3 passed', stderr: '', interrupted: false } }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'python -m pytest | tail -3' })
  const r = await stop($, 'Tests pass now.')
  expect(r.block).toContain('FAILED')
})

test('stale: an edit after the pass blocks the claim until a rerun', async ($, on) => {
  world(on)
  bash(on, () => PASS)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  const r = await stop($, 'Tests are passing.')
  expect(r.block).toContain('stale')
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const r2 = await stop($, 'Tests are passing.')
  expect(r2.block).toBeUndefined()
})

test('stale from outside the session: the git working tree changed after the run', async ($, on) => {
  let tree = ' M src/a.py'
  world(on, { porcelain: () => tree })
  bash(on, () => PASS)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  tree = ' M src/a.py\0 M src/b.py'
  const r = await stop($, 'Verified: all tests pass.')
  expect(r.block).toContain('git working tree changed')
})

test('interrupted: an interrupted run is incomplete and blocks a claim', async ($, on) => {
  world(on)
  bash(on, () => ({ result: { stdout: '', stderr: '', interrupted: true } }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  const r = await stop($, 'The feature is done.')
  expect(r.block).toContain('incomplete')
})

test('render: an ffmpeg run whose output is missing fails', async ($, on) => {
  world(on, { statMissing: true })
  bash(on, () => ({ result: { stdout: '', stderr: 'video:120kB', interrupted: false } }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ffmpeg -y -i in.mp4 -c:v libx264 out/final.mp4' })
  const r = await stop($, 'Render complete.')
  expect(r.block).toContain('missing')
})

test('no claim and honest downgrades pass through', async ($, on) => {
  world(on)
  bash(on, () => FAIL)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect((await stop($, 'Here is the diff for review.')).block).toBeUndefined()
  expect((await stop($, 'NOT VERIFIED: 1 test still fails in test_api.py.')).block).toBeUndefined()
})

test('a claim with no run at all blocks only a verified-pass claim', async ($, on) => {
  world(on)
  await start($)
  expect((await stop($, 'All tests pass.')).block).toContain('no test')
  expect((await stop($, 'Done.')).block).toBeUndefined()
})

test('loop guard: after two returns in one turn the gate yields', async ($, on) => {
  world(on)
  bash(on, () => FAIL)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect((await stop($, 'Tests pass.')).block).toBeDefined()
  expect((await stop($, 'Tests pass.', true)).block).toBeDefined()
  expect((await stop($, 'Tests pass.', true)).block).toBeUndefined()
})

test('unauthorized: a denied command is not evidence', async ($, on) => {
  world(on)
  bash(on, () => ({ deny: 'blocked by policy' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect((await stop($, 'All tests pass.')).block).toContain('no test')
})

test('a grep or echo mentioning a runner is not evidence', async ($, on) => {
  world(on)
  bash(on, () => ({ result: { stdout: 'conftest.py: import pytest', stderr: '', interrupted: false } }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'grep -rn pytest .' })
  await $.tool.call({ tool: 'Bash', command: 'echo "run npm test next"' })
  expect((await stop($, 'All tests pass.')).block).toContain('no test')
})

test('concurrent runs are all recorded and the newest decides', async ($, on) => {
  world(on)
  bash(on, (c) => (c.includes('api') ? FAIL : PASS))
  await start($)
  await Promise.all([
    $.tool.call({ tool: 'Bash', command: 'pytest tests/unit' }),
    $.tool.call({ tool: 'Bash', command: 'npm test' }),
    $.tool.call({ tool: 'Bash', command: 'newman run api.json' }),
  ])
  const r = await stop($, 'All checks pass.')
  expect(r.block).toContain('newman run api.json')
  expect(r.block).not.toContain('npm test')
})

test('off: /qa off lets every claim through, /qa on restores the gate', async ($, on) => {
  world(on)
  bash(on, () => FAIL)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await $.command.run({ ...QA, args: 'off' })
  expect((await stop($, 'Tests pass.')).block).toBeUndefined()
  await $.command.run({ ...QA, args: 'on' })
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect((await stop($, 'Tests pass.')).block).toBeDefined()
})

test('the band shows the newest result on every surface', async ($, on) => {
  world(on)
  bash(on, () => FAIL)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'test-truth-gate', surface, component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false } as never })
    expect((await ui.find({ type: 'Text', text: /FAIL python/ }))?.text).toContain('FAIL')
    await ui.unmount()
  }
})

test('the shell folder: a run after cd is fingerprinted in that folder, not the session root', async ($, on) => {
  const gitDirs: string[] = []
  world(on, { porcelain: () => '', gitDirs })
  on('classic.CwdChanged', () => ({}))
  bash(on, () => PASS)
  await start($)
  await $.classic.CwdChanged({ old_cwd: 'C:/repo', new_cwd: 'C:/repo/pkg' })
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  expect(gitDirs).toEqual(['C:/repo/pkg'])
})
