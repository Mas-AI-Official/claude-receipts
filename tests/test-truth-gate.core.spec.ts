// Pure-core tests for Test Truth Gate, run under node: node --test tests/
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimOf, classify, exitMasked, gate, mutates, outcome, redact, runDir, type Evidence, type GateState } from '../mods/test-truth-gate/hooks/core.ts'

// Fake credentials are assembled at run time so no key-shaped literal sits in source
const FAKE_OPENAI = ['sk', 'abcdefghijklmnopqrstuv'].join('-')
const FAKE_GITHUB = ['ghp', '0123456789abcdefghijABCDEFGHIJ'].join('_')

test('classify: real runners by command word, wrappers and paths included', () => {
  const cases: [string, string | null][] = [
    ['pytest -q', 'python'],
    ['rtk pytest tests/', 'python'],
    ['C:/tools/python311/python.exe -m pytest -x', 'python'],
    ['/d/work/app/.venv/Scripts/python.exe -m pytest', 'python'],
    ['uv run pytest', 'python'],
    ['cd backend && python -m unittest discover', 'python'],
    ['npm test', 'js'],
    ['pnpm run test:unit', 'js'],
    ['npx vitest run', 'js'],
    ['node --experimental-strip-types --test tests/', 'js'],
    ['./node_modules/.bin/jest', 'js'],
    ['newman run collection.json', 'api'],
    ['curl -fsS http://localhost:8000/health', 'api'],
    ['curl --fail-with-body -X POST http://x/api', 'api'],
    ['ffmpeg -y -i a.mp4 out.mp4', 'ffmpeg'],
    ['"C:/tools/ffmpeg.exe" -i a.mp4 b.mp4', 'ffmpeg'],
    ['ffprobe -v error out.mp4', 'ffmpeg'],
    ['claude plugin test mods/x', 'mod'],
    ['FOO=1 pytest', 'python'],
    // not runs
    ['grep -rn pytest .', null],
    ['echo "npm test"', null],
    ['cat jest.config.js', null],
    ['curl -s http://localhost:8000/health', null],
    ['git commit -m "fix pytest"', null],
    ['pip install pytest', null],
    ['ls ffmpeg', null],
  ]
  for (const [cmd, kind] of cases) assert.equal(classify(cmd), kind, cmd)
})

test('outcome: exit codes, masked exits, empty runs, listings', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', interrupted: false })
  assert.equal(outcome('python', 'pytest', ok('5 passed in 1s')).status, 'pass')
  assert.equal(outcome('python', 'pytest', { ...ok(''), isError: true, text: 'Exit code 1\n2 failed, 3 passed' }).exitCode, 1)
  assert.equal(outcome('python', 'pytest | tail -1', ok('2 failed, 3 passed')).status, 'fail')
  assert.equal(outcome('python', 'pytest | tail -1', ok('ok')).status, 'incomplete')
  assert.equal(outcome('python', 'pytest | tail -1', ok('5 passed')).status, 'pass')
  assert.equal(outcome('js', 'npm test || true', ok('done')).status, 'incomplete')
  assert.equal(outcome('python', 'pytest', ok('collected 0 items\nno tests ran')).status, 'incomplete')
  assert.equal(outcome('python', 'pytest --collect-only', ok('12 tests collected')).status, 'incomplete')
  assert.equal(outcome('js', 'npx vitest run', ok('No test files found')).status, 'incomplete')
  assert.equal(outcome('js', 'node --test', ok('# pass 7\n# fail 1')).status, 'fail')
  assert.equal(outcome('js', 'mocha', ok('3 passing\n1 failing')).status, 'fail')
  assert.equal(outcome('ffmpeg', 'ffmpeg -i a.mp4 b.mp4', ok('Conversion failed!')).status, 'fail')
  assert.deepEqual(outcome('ffmpeg', 'ffmpeg -i a.mp4 "out dir/b.mp4"', ok('')).artifacts, ['out dir/b.mp4'])
  assert.equal(outcome('ffmpeg', 'ffmpeg -version', ok('ffmpeg version 7')).status, 'incomplete')
  assert.equal(outcome('js', 'npm test', { ...ok(''), backgroundTaskId: 'b1' }).status, 'incomplete')
  assert.equal(outcome('js', 'npm test', { ...ok(''), timedOutAfterMs: 120000 }).status, 'incomplete')
  // node's default reporter (seen live 2026-11-03), piped into tail
  assert.equal(outcome('js', 'node --test x.ts 2>&1 | tail -8', ok('ℹ tests 6\nℹ pass 6\nℹ fail 0')).status, 'pass')
  assert.equal(outcome('js', 'node --test x.ts | tail -8', ok('ℹ pass 5\nℹ fail 1')).status, 'fail')
  assert.equal(exitMasked('cd app && pytest'), false)
  assert.equal(exitMasked('pytest; echo done'), true)
})

test('runDir: where the command ran, git-bash paths turned into Windows paths', () => {
  assert.equal(runDir('cd /d/work/mods && node --test', 'D:/work'), 'D:/work/mods')
  assert.equal(runDir('cd "D:\\work\\app" && pytest', 'D:/work'), 'D:/work/app')
  assert.equal(runDir('cd backend && pytest', 'D:/work/app'), 'D:/work/app/backend')
  assert.equal(runDir('pytest -q', 'D:/work/app'), 'D:/work/app')
  assert.equal(runDir('pytest; cd elsewhere', 'D:/r'), 'D:/r')
})

test('mutates: commands that change files make evidence stale', () => {
  for (const c of ['git checkout main', 'sed -i s/a/b/ f.py', 'npm install', 'rm -rf build', 'echo x > src/a.py', 'pip install -e .']) assert.equal(mutates(c), true, c)
  for (const c of ['git status', 'ls -la', 'pytest 2>&1', 'cat a > /dev/null', 'grep -rn foo .']) assert.equal(mutates(c), false, c)
})

test('claimOf: strong, weak, honest', () => {
  const cases: [string, string][] = [
    ['All 42 tests pass.', 'strong'],
    ['Fixed the failing test; all tests pass now.', 'strong'],
    ['12 passed, verified.', 'strong'],
    ['Verdict: HELD.', 'strong'],
    ['Done. Ready to merge.', 'weak'],
    ['The feature is implemented.', 'weak'],
    ['NOT VERIFIED: the API test was not run.', 'none'],
    ['Tests are not passing yet.', 'none'],
    ['Once tests pass, merge it.', 'none'],
    ['Should I run the tests?', 'none'],
    ['Here is the plan.', 'none'],
    ['```\n12 passed\n```\nSee the log above for details.', 'none'],
  ]
  for (const [text, want] of cases) assert.equal(claimOf(text), want, text)
})

test('redact: credentials never reach the evidence file', () => {
  const raw = [
    'curl -H "Authorization: Bearer abcdefghijklmnop" https://u:p4ss@api.x.com/v1?token=XYZ123',
    `OPENAI_API_KEY=${FAKE_OPENAI} pytest`,
    'mysql --password hunter2 -e "select 1"',
    `gh auth --with-token ${FAKE_GITHUB}`,
  ].join('\n')
  const out = redact(raw)
  for (const secret of ['abcdefghijklmnop', 'p4ss', 'XYZ123', FAKE_OPENAI, 'hunter2', FAKE_GITHUB]) {
    assert.equal(out.includes(secret), false, `a secret survived: ${out}`)
  }
})

function ev(p: Partial<Evidence>): Evidence {
  return { id: 1, kind: 'python', command: 'pytest', cwd: 'C:/r', status: 'pass', exitCode: 0, summary: '5 passed', at: 1, gen: 0, fingerprint: null, artifacts: [], ...p }
}

test('gate: newest per kind decides; stale, fail, incomplete and background block', () => {
  const st = (evidence: Evidence[], gen = 0): GateState => ({ evidence, gen, lastChange: gen ? { path: 'src/a.py', at: 2, via: 'Edit' } : null })
  const g = (s: GateState, message = 'All tests pass.', fp: string | null = null, bg: string[] = []) => gate({ state: s, message, fingerprintsNow: { 'C:/r': fp }, backgroundTests: bg })
  assert.equal(g(st([ev({ status: 'fail' }), ev({ id: 2 })])).verdict, 'HELD') // fixed by a later run
  assert.equal(g(st([ev({}), ev({ id: 2, status: 'fail' })])).verdict, 'BREACHED')
  assert.equal(g(st([ev({})], 1)).verdict, 'BREACHED') // stale
  assert.equal(g(st([ev({ fingerprint: 'a' })]), undefined, 'b').verdict, 'BREACHED')
  assert.equal(g(st([ev({})]), undefined, null, ['pytest -n 8']).verdict, 'BREACHED')
  assert.equal(g(st([])).verdict, 'BREACHED')
  assert.equal(g(st([]), 'Done.').verdict, 'INCONCLUSIVE')
  assert.equal(g(st([ev({ status: 'fail' })]), 'Done.').verdict, 'BREACHED')
  assert.equal(g(st([ev({ status: 'fail' })]), 'Here is the diff.').verdict, 'NO_CLAIM')
})
