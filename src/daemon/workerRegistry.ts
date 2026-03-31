// Stub: daemon worker registry (Anthropic-internal, requires DAEMON feature flag)
export async function runDaemonWorker(_kind: string): Promise<void> {
  throw new Error('Daemon workers are not available in external builds')
}
