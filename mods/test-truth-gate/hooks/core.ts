// Test Truth Gate: the deterministic core. No `$`, no I/O: every function here
// is pure so the same code runs in the mod, in `claude plugin test`, and under
// `node --test` for the benchmarks.
import { clip, redact } from './shared/redact.ts'

export { clip, redact }

export type Kind = 'python' | 'js' | 'api' | 'ffmpeg' | 'mod'
export type Status = 'pass' | 'fail' | 'incomplete'

export type Evidence = {
  id: number
  kind: Kind
  command: string // redacted
  cwd: string
  status: Status
  exitCode: number | null
  summary: string // one redacted line: counts or the reason
  at: number
  gen: number // the write generation the run saw
  fingerprint: string | null // git working tree at the run, null outside git
  artifacts: string[] // ffmpeg outputs
}

export type Change = { path: string; at: number; via: string }

export type GateState = {
  evidence: Evidence[]
  gen: number
  lastChange: Change | null
}

export type Verdict = {
  verdict: 'HELD' | 'BREACHED' | 'INCONCLUSIVE' | 'NO_CLAIM'
  claim: 'strong' | 'weak' | 'none'
  reasons: string[]
}

// ---------------------------------------------------------------- classify

// Each pattern is matched against one shell segment from its command word on,
// so `grep pytest file` or `echo "npm test"` is never a test run.
const KINDS: [Kind, RegExp][] = [
  ['mod', /^claude(\.exe)?\s+plugin\s+(test|validate)\b/],
  ['python', /^(py\.test|pytest)(\.exe)?(\s|$)|^python[\d.]*(\.exe)?\s+(-[A-Za-z]+\s+)*-m\s+(pytest|unittest)\b|^(tox|nox)(\s|$)/],
  ['js', /^(npm|pnpm|yarn|bun)\s+(run\s+)?test(:[\w-]+)?(\s|$)|^(vitest|jest|mocha)(\s|$)|^playwright\s+test\b|^node(\.exe)?\s+(--[\w-]+\s+)*--test\b|^deno\s+test\b/],
  ['api', /^newman\s+run\b|^schemathesis\b|^st\s+run\b|^hurl\s+(.*\s)?--test\b|^k6\s+run\b|^curl(\.exe)?\s(.*\s)?(--fail|--fail-with-body|-[A-Za-z]*f[A-Za-z]*)(\s|$)/],
  ['ffmpeg', /^ff(mpeg|probe)(\.exe)?(\s|$)/],
]

// Wrappers that run the command after them
const WRAPPER = /^((rtk|time|nice|npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|uv\s+run|poetry\s+run|pipenv\s+run|hatch\s+run|pdm\s+run|env|command|exec)(\s+--?[\w-]+(=\S+)?)*\s+|[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)/

/** The command words of each segment of a shell line, wrappers and env assignments removed. */
export function segments(command: string): string[] {
  const out: string[] = []
  for (const raw of stripNoise(command).split(/\|\||&&|[;|&\n]|\$\(|`|\(|\)/)) {
    let s = raw.trim().replace(/^["']|["']$/g, '')
    for (let guard = 0; guard < 6 && WRAPPER.test(s); guard++) s = s.replace(WRAPPER, '')
    // a full path to the binary counts as the binary: C:/tools/ffmpeg.exe, ./node_modules/.bin/jest
    s = s.replace(/^["']?(?:[A-Za-z]:)?[^\s"']*[\\/]([\w.-]+)["']?(?=\s|$)/, '$1')
    if (s) out.push(s)
  }
  return out
}

/** The kind of verification a shell command runs, or null for any other command. */
export function classify(command: string): Kind | null {
  for (const seg of segments(command)) for (const [kind, re] of KINDS) if (re.test(seg)) return kind
  return null
}

/**
 * The folder a command ran in: a leading `cd <dir> &&` (git-bash `/d/x` or a
 * Windows path, absolute or relative to `base`), else `base`.
 */
export function runDir(command: string, base: string): string {
  const m = /^\s*(?:cd|pushd|Set-Location)\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)/.exec(command)
  if (!m || !m[1]) return base
  let dir = m[1].replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  const bash = /^\/([a-zA-Z])(\/|$)/.exec(dir)
  if (bash) dir = `${bash[1]!.toUpperCase()}:/${dir.slice(3)}`
  else if (!/^[A-Za-z]:\//.test(dir) && !dir.startsWith('/')) dir = `${base.replace(/\/+$/, '')}/${dir}`
  return dir.replace(/\/+$/, '')
}

// A dry or listing run proves nothing about the code
const LISTING = /\s(--collect-only|--co|--listTests|--list|--dry-run|--version|-version|--help|-h)(\s|$)/

// echo/printf text, quoted strings and comments mention test runners without running them
function stripNoise(command: string): string {
  return command
    .replace(/(^|\n)\s*#[^\n]*/g, '$1')
    .replace(/\b(echo|printf|Write-Host|Write-Output)\s+("[^"]*"|'[^']*'|[^;&|\n>]*)/g, '$1 _')
}

// ---------------------------------------------------------------- mutation

const MUTATORS = /\bgit\s+(checkout|switch|merge|rebase|pull|reset|stash|apply|cherry-pick|am|restore|revert)\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|(^|[\s;&|(])(mv|cp|rm|del|move|copy|patch|tee|touch|truncate)(\s|$)|\b(npm|pnpm|yarn)\s+(i|install|ci|add|update|remove|uninstall)\b|\b(pip|pip3|uv\s+pip)\s+install\b|\buv\s+(add|sync|remove)\b|\bSet-Content\b|\bOut-File\b|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b/i

/** True when a non-test shell command may change files a test run depends on. */
export function mutates(command: string): boolean {
  const c = stripNoise(command)
  if (MUTATORS.test(c)) return true
  // a redirect into a file; not >/dev/null, not 2>&1, not > NUL
  return /(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null\b|nul\b|\$null\b)["']?[\w./\\~:-]/i.test(c)
}

const IGNORED_PATH = /(^|[\\/])(\.claude|\.git|node_modules|__pycache__|\.pytest_cache|mods-data|scratchpad|AppData[\\/]Local[\\/]Temp)([\\/]|$)|\.(md|txt|log|ndjson)$/i

/** True when an edit to this path should make earlier test evidence stale. */
export function invalidates(path: string): boolean {
  return !!path && !IGNORED_PATH.test(path)
}

// ---------------------------------------------------------------- outcome

export type RunResult = {
  isError?: boolean
  text?: string
  interrupted?: boolean
  backgroundTaskId?: string
  timedOutAfterMs?: number
  stdout?: string
  stderr?: string
}

export type Outcome = { status: Status; exitCode: number | null; summary: string; artifacts: string[] }

/** What a finished verification command proves, from its result alone. */
export function outcome(kind: Kind, command: string, r: RunResult): Outcome {
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.isError ? r.text ?? '' : ''}`
  const artifacts = kind === 'ffmpeg' ? ffmpegOutputs(command) : []
  if (r.backgroundTaskId) return { status: 'incomplete', exitCode: null, summary: 'moved to the background, result not seen', artifacts }
  if (r.interrupted) return { status: 'incomplete', exitCode: null, summary: 'interrupted', artifacts }
  if (r.timedOutAfterMs) return { status: 'incomplete', exitCode: null, summary: `timed out after ${r.timedOutAfterMs} ms`, artifacts }

  const code = r.isError ? exitCodeOf(r.text ?? out) ?? 1 : 0
  const counts = countsOf(out)
  const summary = counts.text || lastLine(out)

  if (code !== 0) return { status: 'fail', exitCode: code, summary: summary || `exit code ${code}`, artifacts }
  // exit 0 is not proof when the output says otherwise (a pipe into tail hides the code)
  if (counts.failed > 0) return { status: 'fail', exitCode: 0, summary: `${summary} (exit 0, output reports failures)`, artifacts }
  if (kind === 'ffmpeg' && FFMPEG_ERROR.test(out)) return { status: 'fail', exitCode: 0, summary: lastMatch(out, FFMPEG_ERROR), artifacts }
  if (segments(command).some((s) => LISTING.test(` ${s} `) && classifySegment(s))) return { status: 'incomplete', exitCode: 0, summary: 'a listing or dry run, nothing was tested', artifacts }
  if (NO_TESTS.test(out)) return { status: 'incomplete', exitCode: 0, summary: 'no tests ran', artifacts }
  if (kind === 'ffmpeg' && /\bffmpeg\b/.test(command) && artifacts.length === 0) return { status: 'incomplete', exitCode: 0, summary: 'ffmpeg wrote no output file to verify', artifacts }
  if (exitMasked(command) && counts.passed === 0 && kind !== 'ffmpeg') {
    return { status: 'incomplete', exitCode: 0, summary: 'exit code masked (pipe, || true, or a later command) and no pass summary in the output', artifacts }
  }
  return { status: 'pass', exitCode: 0, summary: summary || 'exit 0', artifacts }
}

function classifySegment(seg: string): Kind | null {
  for (const [kind, re] of KINDS) if (re.test(seg)) return kind
  return null
}

/** True when the shell's exit code may not be the verification command's own. */
export function exitMasked(command: string): boolean {
  if (/pipefail/.test(command)) return false
  if (/[^|]\|[^|]/.test(command)) return true // a pipe: the last command's code
  if (/\|\|\s*(true|:|exit\s+0|echo\b)/.test(command)) return true
  const segs = segments(command)
  const last = segs.at(-1) ?? ''
  return segs.length > 1 && !classifySegment(last) && !/^(cd|pushd|Set-Location)\b/.test(last)
}

const NO_TESTS = /\bno tests ran\b|\bcollected 0 items\b|\bNo tests found\b|\bNo test files found\b|\b0 passing\b|# tests 0\b|\bRan 0 tests\b/i
const FFMPEG_ERROR = /\b(Conversion failed!?|Invalid data found when processing input|Error (opening|while) [^\n]*|No such file or directory|Output file is empty[^\n]*)/i

function exitCodeOf(text: string): number | null {
  const m = /\bExit code:?\s*(-?\d+)/i.exec(text)
  return m ? Number(m[1]) : null
}

/** Pass and fail counts from the common runners' summaries. */
export function countsOf(out: string): { passed: number; failed: number; text: string } {
  let passed = 0
  let failed = 0
  const hits: string[] = []
  const add = (re: RegExp, into: 'p' | 'f') => {
    for (const m of out.matchAll(re)) {
      const n = Number(m[1])
      if (into === 'p') passed = Math.max(passed, n)
      else failed = Math.max(failed, n)
      hits.push(m[0].trim())
    }
  }
  add(/\b(\d+) passed\b/g, 'p') // pytest, vitest, jest, playwright
  add(/\b(\d+) (?:failed|errors?)\b/g, 'f') // pytest, vitest, jest
  add(/\b(\d+) passing\b/g, 'p') // mocha
  add(/\b(\d+) failing\b/g, 'f') // mocha
  add(/^# pass (\d+)/gm, 'p') // node --test, TAP reporter
  add(/^# fail (\d+)/gm, 'f') // node --test, TAP reporter
  add(/^ℹ pass (\d+)/gm, 'p') // node --test, default reporter
  add(/^ℹ fail (\d+)/gm, 'f') // node --test, default reporter
  add(/\bTests? run: (\d+)/g, 'p') // unittest-style counts
  const ut = /^FAILED \((?:failures|errors)=(\d+)/m.exec(out) // unittest
  if (ut) {
    failed = Math.max(failed, Number(ut[1]))
    hits.push(ut[0])
  }
  // newman's table: "│ assertions │ 12 │ 1 │"
  const nm = /assertions\s*│\s*(\d+)\s*│\s*(\d+)/.exec(out)
  if (nm) {
    passed = Math.max(passed, Number(nm[1]) - Number(nm[2]))
    failed = Math.max(failed, Number(nm[2]))
    hits.push(`newman ${nm[1]} assertions, ${nm[2]} failed`)
  }
  return { passed, failed, text: clip([...new Set(hits)].slice(-3).join(', '), 160) }
}

function ffmpegOutputs(command: string): string[] {
  if (!/\bffmpeg\b/.test(command)) return []
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const last = parts.at(-1)?.replace(/^["']|["']$/g, '') ?? ''
  return /\.\w{2,4}$/.test(last) && !last.startsWith('-') ? [last] : []
}

function lastLine(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return clip(lines.at(-1) ?? '', 160)
}

function lastMatch(out: string, re: RegExp): string {
  const m = out.match(new RegExp(re.source, 'gi'))
  return clip(m?.at(-1) ?? 'ffmpeg reported an error', 160)
}

// ---------------------------------------------------------------- claims

const STRONG = [
  /\b(all\s+)?(\d+\s+)?(unit\s+|integration\s+|e2e\s+|api\s+)?(tests?|specs?|suites?|checks?|builds?|renders?|qa|ci|test run)\s+(now\s+|all\s+|still\s+)?(pass(es|ed|ing)?|are passing|green|succeed(s|ed)?|ok)\b/i,
  /\b\d+\s+(tests?\s+)?passed\b/i,
  /\b(tests?|suite|everything|it)\s+(is|are)\s+(passing|green)\b/i,
  /\b(verified|confirmed working|works now|fixed and tested|tested and working)\b/i,
  /\bverdict:?\s*HELD\b|\bHELD\b/,
  /✅|✔/,
]
const WEAK = [/\b(done|complete[d]?|finished|shipped|ready to (merge|ship|deploy)|all set|implemented)\b/i]
// A sentence that downgrades or negates is not a claim. "Fixed the failing test;
// all tests pass" still is: failure words alone do not negate.
const HONEST = /\bnot\s+verified\b|\bunverified\b|\bINCONCLUSIVE\b|\bBREACHED\b|\buntested\b|\bnot\b|n't\b|\bnever\b|\bwould\b|\bshould\b|\bonce\b|\bif\b|\bafter (you|we)\b|\?/i

/** Whether the text claims verified success, plain completion, or neither. */
export function claimOf(text: string): 'strong' | 'weak' | 'none' {
  let weak = false
  for (const s of sentences(text)) {
    if (HONEST.test(s)) continue
    if (STRONG.some((re) => re.test(s))) return 'strong'
    if (WEAK.some((re) => re.test(s))) weak = true
  }
  return weak ? 'weak' : 'none'
}

function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------- gate

export type GateInput = {
  state: GateState
  message: string
  fingerprintsNow: Readonly<Record<string, string | null>> // by evidence cwd
  backgroundTests: string[] // test commands still running in the background
}

/** The verdict on the turn's final message against the session's evidence. */
export function gate({ state, message, fingerprintsNow, backgroundTests }: GateInput): Verdict {
  const claim = claimOf(message)
  if (claim === 'none') return { verdict: 'NO_CLAIM', claim, reasons: [] }
  const reasons: string[] = []
  for (const c of backgroundTests) reasons.push(`still running in the background: ${clip(c, 80)}`)

  const latest = latestByKind(state.evidence)
  if (latest.length === 0) {
    if (claim === 'strong') reasons.push('the reply claims a verified pass, but no test, API check or render ran in this session')
    return reasons.length ? { verdict: 'BREACHED', claim, reasons } : { verdict: 'INCONCLUSIVE', claim, reasons: ['no verification ran in this session'] }
  }
  for (const ev of latest) {
    const name = `\`${clip(ev.command, 80)}\``
    if (ev.status === 'fail') reasons.push(`${name} FAILED (${ev.summary})`)
    else if (ev.status === 'incomplete') reasons.push(`${name} is incomplete (${ev.summary})`)
    else if (ev.gen < state.gen) reasons.push(`${name} passed, but ${state.lastChange ? clip(state.lastChange.path, 80) : 'a file'} changed after it (stale)`)
    else if (ev.fingerprint && fingerprintsNow[ev.cwd] && ev.fingerprint !== fingerprintsNow[ev.cwd]) reasons.push(`${name} passed, but the git working tree changed after it (stale)`)
  }
  return reasons.length ? { verdict: 'BREACHED', claim, reasons } : { verdict: 'HELD', claim, reasons: [] }
}

/** The newest run of each kind and directory: an older failure a later run fixed does not count. */
export function latestByKind(evidence: readonly Evidence[]): Evidence[] {
  const by = new Map<string, Evidence>()
  for (const ev of evidence) by.set(`${ev.kind}|${ev.cwd}`, ev)
  return [...by.values()]
}

/** The instruction the model reads when the gate blocks its stop. */
export function blockText(v: Verdict): string {
  return [
    `Test Truth Gate: your reply claims ${v.claim === 'strong' ? 'a verified pass' : 'the work is done'}, but the evidence does not hold it:`,
    ...v.reasons.map((r) => `- ${r}`),
    'Rerun the verification in the foreground and report its real result, or restate the reply as NOT VERIFIED and name the check that was not run. Do not weaken or skip a test to make it pass.',
  ].join('\n')
}

/** git status --porcelain=v1 -z lines plus their mtimes, reduced to one short key. */
export function fingerprint(head: string, porcelain: string, mtimes: Record<string, number>): string {
  const files = porcelain.split('\0').filter(Boolean).sort()
  const body = head.trim() + '\n' + files.map((f) => `${f}@${mtimes[f.slice(3)] ?? 0}`).join('\n')
  return hash(body)
}

// FNV-1a 32-bit, twice with different seeds: a change detector, not a security hash
export function hash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export const MAX_EVIDENCE = 200
