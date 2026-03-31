// Stub: background session management (requires BG_SESSIONS feature flag)
export async function psHandler(_args: string[]): Promise<void> {
  throw new Error('Background sessions are not available in external builds')
}
export async function logsHandler(_sessionId: string): Promise<void> {
  throw new Error('Background sessions are not available in external builds')
}
export async function attachHandler(_sessionId: string): Promise<void> {
  throw new Error('Background sessions are not available in external builds')
}
export async function killHandler(_sessionId: string): Promise<void> {
  throw new Error('Background sessions are not available in external builds')
}
export async function handleBgFlag(_args: string[]): Promise<void> {
  throw new Error('Background sessions are not available in external builds')
}
