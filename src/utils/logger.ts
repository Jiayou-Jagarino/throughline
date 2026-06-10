// Debug logger — gated behind THROUGHLINE_DEBUG env var.
// Silent by default; use for internal diagnostics that should not clutter
// normal CLI output.
const DEBUG_ENABLED = typeof process !== 'undefined' && (
  process.env.THROUGHLINE_DEBUG === '1' ||
  process.env.THROUGHLINE_DEBUG === 'true'
)

export function debug(...args: unknown[]): void {
  if (DEBUG_ENABLED) {
    console.error('[throughline:debug]', ...args)
  }
}

export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED
}
