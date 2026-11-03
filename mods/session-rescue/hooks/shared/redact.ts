// Shared by every mod in this repo. Edit shared/redact.ts, then run
// `node scripts/sync-shared.ts`; tests fail when a mod's copy drifts.

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ---------------------------------------------------------------- redaction

const SECRET_RULES: [RegExp, string][] = [
  [/\b(authorization|x-api-key|api-key|cookie)\s*:\s*(bearer\s+)?[^\s"']+/gi, '$1: [REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\b(sk-ant-[\w-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[\w-]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+)/g, '[REDACTED]'],
  [/(--?(?:password|passwd|pass|token|secret|api[-_]?key|key|auth)[=\s])("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]'],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=[REDACTED]'],
  [/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@'],
  [/([?&](?:token|key|api_key|access_token|sig|signature|password)=)[^&\s"']+/gi, '$1[REDACTED]'],
]

/** Text with the common credential shapes replaced, for anything written to disk. */
export function redact(text: string): string {
  let t = text
  for (const [re, to] of SECRET_RULES) t = t.replace(re, to)
  return t
}
