// Every mod carries an exact copy of shared/; a drifted copy means sync-shared.ts was not run.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')

test('shared code: each mod copy matches shared/', () => {
  const mods = readdirSync(join(root, 'mods'))
  for (const f of readdirSync(join(root, 'shared'))) {
    const want = readFileSync(join(root, 'shared', f), 'utf8')
    for (const mod of mods) {
      const copy = join(root, 'mods', mod, 'hooks', 'shared', f)
      assert.ok(existsSync(copy), `${mod} is missing shared/${f}`)
      assert.equal(readFileSync(copy, 'utf8'), want, `${mod}/hooks/shared/${f} drifted: run node scripts/sync-shared.ts`)
    }
  }
})
