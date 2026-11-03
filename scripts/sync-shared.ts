// Copies shared/*.ts into every mod's hooks/shared/, so each mod installs on its own.
// Run: node scripts/sync-shared.ts   (tests/shared.spec.ts fails when a copy drifts)
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
for (const mod of readdirSync(join(root, 'mods'))) {
  const dest = join(root, 'mods', mod, 'hooks', 'shared')
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(join(root, 'shared'))) copyFileSync(join(root, 'shared', f), join(dest, f))
}
