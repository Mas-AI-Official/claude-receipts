// Test Truth Gate: records the real result of every test, API check and render
// the session runs, marks it stale when a file changes after it, and refuses
// the turn's stop when the final reply claims success the evidence does not
// hold. Deterministic: it adds no model call and no prompt text unless it blocks.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  blockText,
  claimOf,
  classify,
  clip,
  fingerprint,
  gate,
  invalidates,
  latestByKind,
  MAX_EVIDENCE,
  mutates,
  outcome,
  redact,
  runDir,
  type Evidence,
  type GateState,
  type RunResult,
} from './core.ts'

const P = 'test-truth-gate'
const EMPTY: GateState = { evidence: [], gen: 0, lastChange: null }
const gateAtom = atom({ plugin: 'test-truth-gate', key: 'gate' } as const, EMPTY)
const enabledAtom = atom({ plugin: 'test-truth-gate', key: 'enabled' } as const, true)
// The Bash tool's own folder: Claude Code drops a leading `cd` into the folder the shell is already in
const shellCwdAtom = atom({ plugin: 'test-truth-gate', key: 'shellCwd' } as const, '')
const MAX_BLOCKS_PER_TURN = 2
const FINGERPRINT_FILES = 300

let home = ''
let sessionId = ''
let cwd = ''
let blocks = 0
let commandName = 'qa'

async function now($: EngineInterface): Promise<number> {
  return $.clock.now()
}

function evidenceFile(): string {
  return `${home}/.claude/mods-data/masai/test-truth-gate/${sessionId || 'unknown'}.json`
}

// The session's evidence on disk, so another agent or a rescued session can read it
async function persist($: EngineInterface, st: GateState): Promise<void> {
  if (!home) return
  try {
    await $.fs.write(evidenceFile(), JSON.stringify({ sessionId, cwd, updatedAt: await now($), ...st }))
  } catch {
    // a locked file: the next run writes it again
  }
}

// HEAD plus the dirty files and their mtimes: catches edits made outside this session
async function treeFingerprint($: EngineInterface, dir: string): Promise<string | null> {
  try {
    const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel', 'HEAD'], { timeoutMs: 5000 })
    if (top.exitCode !== 0) return null
    const [root = '', head = ''] = top.stdout.split(/\r?\n/)
    const st = await $.process.run(['git', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { timeoutMs: 10000 })
    if (st.exitCode !== 0) return null
    const mtimes: Record<string, number> = {}
    const entries = st.stdout.split('\0').filter(Boolean).slice(0, FINGERPRINT_FILES)
    for (const entry of entries) {
      const rel = entry.slice(3)
      try {
        mtimes[rel] = (await $.fs.stat(`${root}/${rel}`)).mtimeMs
      } catch {
        mtimes[rel] = -1 // deleted
      }
    }
    return fingerprint(head, entries.join('\0'), mtimes)
  } catch {
    return null
  }
}

async function bump($: EngineInterface, path: string, via: string): Promise<void> {
  const at = await now($)
  await update($, gateAtom, (s) => ({ ...s, gen: s.gen + 1, lastChange: { path: redact(path), at, via } }))
}

// The shared ledger LEDGER DUTY names; fail-open, one line per verdict on a claim
async function ledger($: EngineInterface, line: Record<string, unknown>): Promise<void> {
  try {
    const dir = await $.env.get('MASAI_LEDGER_DIR')
    if (!dir || !(await $.fs.exists(dir))) return
    const text = JSON.stringify({ ts: new Date(await now($)).toISOString(), runtime: 'claude-code', mod: P, session: sessionId, ...line })
    await $.process.run(['node', '-e', 'require("fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")', `${dir}/aqa_verdicts.ndjson`, text], { timeoutMs: 5000 })
  } catch {
    // the ledger is best effort; the gate's own verdict already stands
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

function statusOf(ev: Evidence, st: GateState): 'PASS' | 'FAIL' | 'INCOMPLETE' | 'STALE' {
  if (ev.status === 'fail') return 'FAIL'
  if (ev.status === 'incomplete') return 'INCOMPLETE'
  return ev.gen < st.gen ? 'STALE' : 'PASS'
}

async function reportText($: EngineInterface): Promise<string> {
  const st = await read($, gateAtom)
  const on = await read($, enabledAtom)
  const t = await now($)
  const lines = [`Test Truth Gate is ${on ? 'on' : 'off'}. ${st.evidence.length} run(s) recorded, ${st.gen} file change(s) seen.`]
  const latest = latestByKind(st.evidence)
  if (!latest.length) lines.push('No test, API check or render has run in this session.')
  for (const ev of latest) lines.push(`${statusOf(ev, st).padEnd(10)} ${ev.kind.padEnd(6)} ${ago(t - ev.at)} ago  ${clip(ev.command, 70)}  (${ev.summary})`)
  if (st.lastChange) lines.push(`Last change: ${clip(st.lastChange.path, 80)} ${ago(t - st.lastChange.at)} ago`)
  lines.push(`Evidence file: ${evidenceFile()}`)
  lines.push(`/${commandName} on|off|clear`)
  return lines.join('\n')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
    sessionId = await $.session.id()
    cwd = await $.session.cwd()
    try {
      await $.command.register({ name: 'qa', description: 'Test Truth Gate: the session\'s test, API and render evidence (on|off|clear)', argumentHint: '[on|off|clear]', immediate: true })
    } catch {
      try {
        await $.command.register({ name: 'ttg', description: 'Test Truth Gate: the session\'s test, API and render evidence (on|off|clear)', argumentHint: '[on|off|clear]', immediate: true })
        commandName = 'ttg'
      } catch {
        // no command; the band and the gate still work
      }
    }
    return next(e)
  })

  on('command.run', { command: ['qa', 'ttg'] }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await update($, enabledAtom, () => arg === 'on')
      return { text: `Test Truth Gate ${arg}.` }
    }
    if (arg === 'clear') {
      await update($, gateAtom, () => EMPTY)
      return { text: 'Evidence cleared for this session. The next success claim needs a fresh run.' }
    }
    return { text: await reportText($) }
  })

  on('prompt.submit', ($, e, next) => {
    blocks = 0
    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await update($, shellCwdAtom, () => e.new_cwd)
    return next(e)
  })

  // Every shell command: a verification run becomes evidence, a mutating command makes it stale
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.deny !== undefined || !(await read($, enabledAtom))) return r
      const base = (await read($, shellCwdAtom)) || (await $.session.cwd()) || cwd
      const kind = classify(e.command)
      if (!kind) {
        if (mutates(e.command) && !r.isError) await bump($, `shell: ${clip(e.command, 80)}`, 'bash')
        return r
      }
      const res = (r.result ?? {}) as RunResult
      const o = outcome(kind, e.command, { ...res, isError: r.isError === true, text: r.text })
      // a render passes only when its output file exists and is not empty
      if (o.status === 'pass' && o.artifacts.length) {
        for (const a of o.artifacts) {
          const full = /^([A-Za-z]:|\/|\\)/.test(a) ? a : `${runDir(e.command, base)}/${a}`
          const size = await $.fs.stat(full).then((s) => (s.kind === 'file' ? s.size : 0), () => -1)
          if (size <= 0) {
            o.status = 'fail'
            o.summary = size < 0 ? `output ${a} is missing` : `output ${a} is empty`
            break
          }
        }
      }
      const at = await now($)
      const dir = runDir(e.command, base)
      const fp = await treeFingerprint($, dir)
      const st = await update($, gateAtom, (s) => {
        const ev: Evidence = {
          id: (s.evidence.at(-1)?.id ?? 0) + 1,
          kind,
          command: clip(redact(e.command), 300),
          cwd: dir,
          status: o.status,
          exitCode: o.exitCode,
          summary: clip(redact(o.summary), 200),
          at,
          gen: s.gen,
          fingerprint: fp,
          artifacts: o.artifacts.map(redact),
        }
        return { ...s, evidence: [...s.evidence, ev].slice(-MAX_EVIDENCE) }
      })
      await persist($, st)
      $.ui.invalidate('ui.render')
    } catch (err) {
      $.ui.log(`${P}: evidence not recorded (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
    }
    return r
  })

  // A file edit after a run makes that run stale
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.deny !== undefined || r.isError || !(await read($, enabledAtom))) return r
      const args = e as { file_path?: string; notebook_path?: string }
      const path = args.file_path ?? args.notebook_path ?? ''
      if (invalidates(path)) {
        await bump($, path, e.tool)
        await persist($, await read($, gateAtom))
        $.ui.invalidate('ui.render')
      }
    } catch {
      // bookkeeping only
    }
    return r
  })

  // The completion gate: a success claim on failed, incomplete or stale evidence goes back to the model
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.block || !(await read($, enabledAtom))) return r
      const message = e.last_assistant_message ?? ''
      if (claimOf(message) === 'none') return r
      const st = await read($, gateAtom)
      const backgroundTests = (e.background_tasks ?? [])
        .filter((t) => /running|pending/i.test(t.status) && classify(t.command ?? t.description) !== null)
        .map((t) => t.command ?? t.description)
      const fingerprintsNow: Record<string, string | null> = {}
      for (const ev of latestByKind(st.evidence)) {
        if (ev.fingerprint && !(ev.cwd in fingerprintsNow)) fingerprintsNow[ev.cwd] = await treeFingerprint($, ev.cwd)
      }
      const v = gate({ state: st, message, fingerprintsNow, backgroundTests })
      if (v.verdict === 'NO_CLAIM') return r
      const verdict = v.verdict === 'BREACHED' && blocks >= MAX_BLOCKS_PER_TURN ? 'INCONCLUSIVE' : v.verdict
      await ledger($, { verdict, claim: v.claim, reasons: v.reasons.map(redact), gated: verdict === 'BREACHED' })
      if (v.verdict !== 'BREACHED') return r
      if (blocks >= MAX_BLOCKS_PER_TURN) {
        $.ui.toast(`Test Truth Gate: the reply still claims success the evidence does not hold, after ${blocks} returns. Treat it as NOT VERIFIED.`, { timeoutMs: 15000 })
        return r
      }
      blocks += 1
      return { ...r, block: blockText(v) }
    } catch (err) {
      $.ui.log(`${P}: gate skipped (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
      return r
    }
  })

  // One line above the prompt once anything ran: the newest result of each kind
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const st = await read($, gateAtom)
    if (e.props.hasSurvey || !st.evidence.length || !(await read($, enabledAtom))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const t = await now($)
    const COLORS = { PASS: 'green', FAIL: 'red', INCOMPLETE: 'yellow', STALE: 'yellow' } as const
    return (
      <Box flexDirection="row">
        <Text dimColor>QA </Text>
        {latestByKind(st.evidence).slice(-4).map((ev) => {
          const s = statusOf(ev, st)
          return (
            <Text color={COLORS[s]}>
              {s} {ev.kind} {ago(t - ev.at)}{'  '}
            </Text>
          )
        })}
      </Box>
    )
  })
}
