// Session Rescue state contract (self-contained, mirrors hooks/core.ts)
export type StepStatus = 'running' | 'ok' | 'failed' | 'interrupted'
export type Step = {
  id: number
  at: number
  tool: string
  what: string // redacted command, or the file path an edit touched
  status: StepStatus
  test: boolean
  destructive: boolean
}
export type Checkpoint = {
  v: 1
  seq: number
  session: string
  cwd: string
  goal: string // the first request of the session
  lastPrompt: string
  startedAt: number
  updatedAt: number
  steps: Step[]
  files: string[]
  ended: boolean
  dismissed: boolean
}
export type Verdict = 'VERIFIED' | 'UNVERIFIED' | 'INTERRUPTED' | 'EMPTY'

declare module 'claude-code' {
  interface PluginState {
    'session-rescue': { checkpoint: Checkpoint | null; found: Checkpoint | null; guard: Record<string, string> }
  }
}
