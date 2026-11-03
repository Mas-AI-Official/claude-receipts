// Self-contained contract: mirrors Evidence, Change and GateState in hooks/core.ts.
export type Kind = 'python' | 'js' | 'api' | 'ffmpeg' | 'mod'
export type Status = 'pass' | 'fail' | 'incomplete'
export type Evidence = {
  id: number
  kind: Kind
  command: string
  cwd: string
  status: Status
  exitCode: number | null
  summary: string
  at: number
  gen: number
  fingerprint: string | null
  artifacts: string[]
}
export type Change = { path: string; at: number; via: string }
export type GateState = { evidence: Evidence[]; gen: number; lastChange: Change | null }

declare module 'claude-code' {
  interface PluginState {
    'test-truth-gate': { gate: GateState; enabled: boolean; shellCwd: string }
  }
}
