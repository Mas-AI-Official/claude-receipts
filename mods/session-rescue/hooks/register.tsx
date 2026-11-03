// Session Rescue: keeps a redacted checkpoint of the session's work on disk
// (requests, commands with their real outcome, files changed) and offers it to
// the next session in the same folder when the work was interrupted or left
// unverified. It never reruns anything; a loaded checkpoint blocks the exact
// destructive commands that did not finish until the person allows each one.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  ago,
  clip,
  contextFor,
  decode,
  encode,
  fresh,
  guarded,
  isDestructive,
  isTest,
  MAX_FILES,
  MAX_STEPS,
  norm,
  pick,
  redact,
  slotOf,
  summary,
  verdict,
  type Checkpoint,
  type Step,
  type StepStatus,
} from './core.ts'

const P = 'session-rescue'
const cpAtom = atom({ plugin: 'session-rescue', key: 'checkpoint' } as const, null as Checkpoint | null)
const foundAtom = atom({ plugin: 'session-rescue', key: 'found' } as const, null as Checkpoint | null)
// exact commands a loaded checkpoint holds back, by step id
const guardAtom = atom({ plugin: 'session-rescue', key: 'guard' } as const, {} as Record<string, string>)
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

let home = ''

function dir(): string {
  return `${home}/.claude/mods-data/masai/session-rescue`
}

// One of the session's two slot files; see the slot note in core.ts
async function save($: EngineInterface): Promise<void> {
  const cp = await update($, cpAtom, (c) => (c ? { ...c, seq: c.seq + 1 } : c))
  if (!cp || !home) return
  try {
    await $.fs.write(`${dir()}/${cp.session}.${slotOf(cp.seq)}.json`, encode({ ...cp, updatedAt: await $.clock.now() }))
  } catch (err) {
    $.ui.log(`${P}: checkpoint not written (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
  }
}

async function readSession($: EngineInterface, session: string): Promise<Checkpoint | null> {
  const texts = await Promise.all(['a', 'b'].map((s) => $.fs.read(`${dir()}/${session}.${s}.json`).catch(() => null)))
  return decode(texts)
}

async function scan($: EngineInterface, session: string, cwd: string): Promise<Checkpoint | null> {
  if (!home || !(await $.fs.exists(dir()))) return null
  const names = (await $.fs.list(dir())).filter((f) => f.kind === 'file' && /\.[ab]\.json$/.test(f.name)).map((f) => f.name.replace(/\.[ab]\.json$/, ''))
  const cps: Checkpoint[] = []
  for (const s of new Set(names)) {
    if (s === session) continue
    const cp = await readSession($, s)
    if (cp) cps.push(cp)
  }
  return pick(cps, session, cwd, await $.clock.now())
}

async function addStep($: EngineInterface, step: Omit<Step, 'id' | 'at'>): Promise<number> {
  const at = await $.clock.now()
  let id = 0
  await update($, cpAtom, (c) => {
    if (!c) return c
    id = (c.steps.at(-1)?.id ?? 0) + 1
    return { ...c, steps: [...c.steps, { ...step, id, at }].slice(-MAX_STEPS) }
  })
  return id
}

async function setStatus($: EngineInterface, id: number, status: StepStatus | null): Promise<void> {
  await update($, cpAtom, (c) =>
    c ? { ...c, steps: status ? c.steps.map((s) => (s.id === id ? { ...s, status } : s)) : c.steps.filter((s) => s.id !== id) } : c,
  )
}

type BashResult = { interrupted?: boolean; backgroundTaskId?: string; timedOutAfterMs?: number }

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
    const session = await $.session.id()
    const cwd = await $.session.cwd()
    try {
      // a reload or resume keeps this session's own checkpoint
      const own = (await read($, cpAtom)) ?? (await readSession($, session)) ?? fresh(session, cwd, await $.clock.now())
      await update($, cpAtom, () => ({ ...own, ended: false }))
      await update($, foundAtom, () => null)
      const found = await scan($, session, cwd)
      if (found) await update($, foundAtom, () => found)
    } catch (err) {
      $.ui.log(`${P}: start skipped (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
    }
    try {
      await $.command.register({ name: 'rescue', description: 'Session Rescue: show, load, allow or dismiss unfinished work from an earlier session', argumentHint: '[load|allow <n>|dismiss|status]', immediate: true })
    } catch {
      // no command: the checkpoint is still written
    }
    return next(e)
  })

  on('command.run', { command: 'rescue' }, async ($, e) => {
    const [verb = '', arg = ''] = String(e.args || '').trim().split(/\s+/)
    const t = await $.clock.now()
    const found = await read($, foundAtom)
    if (verb === 'status') {
      const cp = await read($, cpAtom)
      return { text: cp ? summary(cp, t) : 'No checkpoint in this session yet.' }
    }
    if (verb === 'allow') {
      const g = await read($, guardAtom)
      if (!(arg in g)) return { text: `No held command with number ${arg}. Held: ${Object.keys(g).join(', ') || 'none'}.` }
      await update($, guardAtom, (x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== arg)))
      return { text: `Allowed step ${arg}: ${clip(g[arg] ?? '', 120)}. Claude may run it again if it asks.` }
    }
    if (!found) return { text: 'Nothing to rescue: no unfinished or unverified session in this folder in the last 7 days.\n/rescue status shows this session\'s own checkpoint.' }
    if (verb === 'dismiss') {
      const gone = { ...found, dismissed: true, seq: found.seq + 1 }
      await $.fs.write(`${dir()}/${found.session}.${slotOf(gone.seq)}.json`, encode(gone))
      await update($, foundAtom, () => null)
      return { text: `Dismissed the checkpoint of session ${found.session.slice(0, 8)}.` }
    }
    if (verb === 'load') {
      const held = Object.fromEntries(guarded(found).map((s) => [String(s.id), norm(s.what)]))
      await update($, guardAtom, () => held)
      await update($, foundAtom, () => null)
      const n = Object.keys(held).length
      return {
        text: `Loaded into Claude's context: ${verdict(found)}, ${found.files.length} file(s), ${found.steps.length} step(s).${n ? ` ${n} destructive command(s) held until you run /rescue allow <n>.` : ''}`,
        context: [contextFor(found, t)],
      }
    }
    return { text: `${summary(found, t)}\n\n/rescue load  gives it to Claude (nothing is rerun)\n/rescue dismiss  forgets it` }
  })

  on('prompt.submit', async ($, e, next) => {
    const text = clip(redact(String(e.text ?? '')), 400)
    if (text && !text.startsWith('/')) {
      await update($, cpAtom, (c) => (c ? { ...c, goal: c.goal || text, lastPrompt: text } : c))
      await save($)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const held = Object.entries(await read($, guardAtom)).find(([, c]) => c === norm(command))
    if (held) {
      return {
        deny: `Session Rescue holds this command: it was step ${held[0]} of a rescued session and did not finish, and it is destructive. Ask the user to confirm and to run /rescue allow ${held[0]}; do not rewrite it to get around the hold.`,
      }
    }
    const id = await addStep($, { tool: 'Bash', what: clip(redact(command), 300), status: 'running', test: isTest(command), destructive: isDestructive(command) })
    await save($) // a crash during the command leaves it IN FLIGHT on disk
    let r
    try {
      r = await next(e)
    } catch (err) {
      await setStatus($, id, 'interrupted')
      await save($)
      throw err
    }
    const res = (r.result ?? {}) as BashResult
    const status: StepStatus | null =
      r.deny !== undefined ? null : res.interrupted || res.backgroundTaskId || res.timedOutAfterMs ? 'interrupted' : r.isError ? 'failed' : 'ok'
    await setStatus($, id, status)
    await save($)
    return r
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    const input = e as unknown as { tool: string; file_path?: string; notebook_path?: string }
    const path = String(input.file_path ?? input.notebook_path ?? '')
    if (path) {
      await addStep($, { tool: input.tool, what: clip(redact(path), 300), status: 'ok', test: false, destructive: false })
      await update($, cpAtom, (c) => (c ? { ...c, files: [...c.files.filter((f) => f !== path), redact(path)].slice(-MAX_FILES) } : c))
      await save($)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    await update($, cpAtom, (c) => (c ? { ...c, ended: true } : c))
    await save($)
    return next(e)
  })

  // One line above the prompt while an earlier session's unfinished work waits
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const found = await read($, foundAtom)
    if (e.props.hasSurvey || !found) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const v = verdict(found)
    return (
      <Box flexDirection="row">
        <Text color={v === 'INTERRUPTED' ? 'red' : 'yellow'}>RESCUE {v} </Text>
        <Text dimColor>
          work from {ago((await $.clock.now()) - found.updatedAt)} ago, {found.files.length} file(s): /rescue
        </Text>
      </Box>
    )
  })
}
