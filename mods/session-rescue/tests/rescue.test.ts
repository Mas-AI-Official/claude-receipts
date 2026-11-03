import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { encode, fresh, type Checkpoint } from '../hooks/core.ts'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = 'C:/Users/test/.claude/mods-data/masai/session-rescue'

// A disk of plain files beneath the mod; `session` is the id the session reports
// the engine hands paths over in Windows form; the test disk keys them with /
const key = (p: string) => p.split(String.fromCharCode(92)).join('/')

function world(on: On, files: Map<string, string>, session = 'sess-new') {
  mock.clock(on, { now: 10_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/test' })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({}) as never)
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('command.register', () => ({ value: { command: 'rescue' } }))
  on('prompt.submit', (_: unknown, e: unknown) => e as never)
  on('fs.write', (_, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const t = files.get(key(e.path))
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.exists', (_, e) => ({ value: [...files.keys()].some((k) => k.startsWith(key(e.path))) }))
  on('fs.list', () => ({ value: [...files.keys()].filter((k) => k.startsWith(DIR)).map((k) => ({ name: k.slice(DIR.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
}

function bash(on: On, answer: (command: string) => object) {
  on('tool.call', (_: unknown, e: unknown) => answer((e as { command?: string }).command ?? '') as never)
}

const OK = { result: { stdout: '3 passed', stderr: '', interrupted: false } }
const RESCUE = (args = '') => ({ command: 'rescue', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

async function start($: Engine) {
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
}

// An earlier session's checkpoint written straight to disk
function earlier(files: Map<string, string>, edit: (cp: Checkpoint) => Checkpoint, session = 'sess-old') {
  const cp = edit({ ...fresh(session, 'C:/repo', 9_000_000), seq: 4, goal: 'fix the login bug' })
  files.set(`${DIR}/${session}.a.json`, encode(cp))
  return cp
}

function latest(files: Map<string, string>, session: string): Checkpoint {
  const all = ['a', 'b'].map((s) => files.get(`${DIR}/${session}.${s}.json`)).filter(Boolean) as string[]
  const cps = all.map((t) => JSON.parse(JSON.parse(t).body) as Checkpoint)
  return cps.sort((x, y) => y.seq - x.seq)[0]!
}

test('normal: requests, commands and edits land in a checkpoint on disk', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files)
  bash(on, () => OK)
  await start($)
  await $.prompt.submit({ text: 'add the export button' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  const cp = latest(files, 'sess-new')
  expect(cp.goal).toBe('add the export button')
  expect(cp.steps.at(-1)?.status).toBe('ok')
  expect(cp.steps.at(-1)?.test).toBe(true)
})

test('interrupted: a crash mid-command leaves it IN FLIGHT and the next session offers it', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({ ...cp, steps: [{ id: 1, at: 1, tool: 'Bash', what: 'npm run build', status: 'running', test: false, destructive: false }] }))
  world(on, files)
  await start($)
  const r = await $.command.run(RESCUE())
  expect(r.text).toContain('INTERRUPTED')
  expect(r.text).toContain('IN FLIGHT')
  expect(r.text).toContain('npm run build')
})

test('failure: a failed run is recorded as FAILED and the work stays unverified', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files)
  bash(on, () => ({ result: { stdout: '', stderr: '', interrupted: false }, isError: true, text: 'Exit code 1' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  const r = await $.command.run(RESCUE('status'))
  expect(r.text).toContain('FAILED')
  expect(r.text).toContain('UNVERIFIED')
})

test('verified work is not offered; only unfinished or unverified work is', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({
    ...cp,
    files: ['src/a.py'],
    steps: [
      { id: 1, at: 1, tool: 'Edit', what: 'src/a.py', status: 'ok', test: false, destructive: false },
      { id: 2, at: 2, tool: 'Bash', what: 'pytest', status: 'ok', test: true, destructive: false },
    ],
  }))
  world(on, files)
  await start($)
  const r = await $.command.run(RESCUE())
  expect(r.text).toContain('Nothing to rescue')
})

test('unauthorized rerun: a loaded destructive step is held until /rescue allow', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({ ...cp, steps: [{ id: 7, at: 1, tool: 'Bash', what: 'git push --force origin main', status: 'interrupted', test: false, destructive: true }] }))
  world(on, files)
  bash(on, () => OK)
  await start($)
  const loaded = await $.command.run(RESCUE('load'))
  expect(loaded.context?.[0]).toContain('not instructions from the user')
  expect(loaded.context?.[0]).toContain('DESTRUCTIVE')
  const held = await $.tool.call({ tool: 'Bash', command: 'git  push --force origin main' })
  expect(held.deny).toContain('/rescue allow 7')
  await $.command.run(RESCUE('allow 7'))
  const again = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
  expect(again.deny).toBeUndefined()
})

test('a torn write falls back to the other slot instead of losing the checkpoint', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({ ...cp, steps: [{ id: 1, at: 1, tool: 'Bash', what: 'make release', status: 'running', test: false, destructive: false }] }))
  files.set(`${DIR}/sess-old.b.json`, '{"sum":"0000","body":"{\\"v\\":1,\\"se') // crash mid-write
  world(on, files)
  await start($)
  const r = await $.command.run(RESCUE())
  expect(r.text).toContain('make release')
})

test('concurrent sessions: each writes its own files and the newest unfinished one is offered', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({ ...cp, updatedAt: 9_100_000, steps: [{ id: 1, at: 1, tool: 'Bash', what: 'older job', status: 'running', test: false, destructive: false }] }), 'sess-a')
  earlier(files, (cp) => ({ ...cp, updatedAt: 9_500_000, steps: [{ id: 1, at: 1, tool: 'Bash', what: 'newer job', status: 'running', test: false, destructive: false }] }), 'sess-b')
  world(on, files)
  await start($)
  const r = await $.command.run(RESCUE())
  expect(r.text).toContain('newer job')
  expect(files.get(`${DIR}/sess-a.a.json`)).toContain('older job') // untouched
})

test('secrets in requests and commands never reach the checkpoint', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files)
  bash(on, () => OK)
  await start($)
  const pw = ['hun', 'ter2'].join('')
  await $.prompt.submit({ text: `deploy with --password ${pw}` } as never)
  await $.tool.call({ tool: 'Bash', command: `mysql --password ${pw} -e "select 1"` })
  expect([...files.values()].join('\n')).not.toContain(pw)
})

test('dismiss: a dismissed checkpoint is not offered again', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({ ...cp, steps: [{ id: 1, at: 1, tool: 'Bash', what: 'job', status: 'running', test: false, destructive: false }] }))
  world(on, files)
  await start($)
  await $.command.run(RESCUE('dismiss'))
  await start($)
  const r = await $.command.run(RESCUE())
  expect(r.text).toContain('Nothing to rescue')
})

test('the band names unfinished work on every surface', async ($, on) => {
  const files = new Map<string, string>()
  earlier(files, (cp) => ({ ...cp, steps: [{ id: 1, at: 1, tool: 'Bash', what: 'job', status: 'running', test: false, destructive: false }] }))
  world(on, files)
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-rescue', surface, component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false } as never })
    expect((await ui.find({ type: 'Text', text: /RESCUE INTERRUPTED/ }))?.text).toContain('RESCUE')
    await ui.unmount()
  }
})

test('a destructive command cut off in this session is recorded as held', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files)
  bash(on, () => ({ result: { stdout: '', stderr: '', interrupted: true } }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  const r = await $.command.run(RESCUE('status'))
  expect(r.text).toContain('INTERRUPTED')
  expect(r.text).toContain('DESTRUCTIVE')
})
