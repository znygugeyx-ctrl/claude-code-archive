import { describe, expect, mock, test } from 'bun:test'

// bun:bundle must be mocked before any module that imports it is loaded
mock.module('bun:bundle', () => ({ feature: () => false }))

// Mock all heavy/external dependencies of autoCompact.ts
mock.module('src/bootstrap/state.js', () => ({
  markPostCompaction: () => {},
  getSdkBetas: () => [],
}))
mock.module('../../bootstrap/state.js', () => ({
  markPostCompaction: () => {},
  getSdkBetas: () => [],
}))
mock.module('../../utils/tokens.js', () => ({
  // Synchronous — always reports huge token count so shouldAutoCompact returns true
  tokenCountWithEstimation: () => 1_000_000,
}))
mock.module('../../utils/context.js', () => ({
  getContextWindowForModel: () => 200_000,
}))
mock.module('../api/claude.js', () => ({
  getMaxOutputTokensForModel: () => 8_192,
}))
mock.module('../../utils/config.js', () => ({
  // autoCompactEnabled: true so isAutoCompactEnabled() returns true
  getGlobalConfig: () => ({ autoCompactEnabled: true }),
}))
mock.module('../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
mock.module('./compact.js', () => ({
  compactConversation: async () => ({
    type: 'full',
    summary: 'Compacted.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summary.' }] }],
  }),
  ERROR_MESSAGE_USER_ABORT: 'User aborted',
}))
mock.module('./sessionMemoryCompact.js', () => ({
  trySessionMemoryCompaction: async () => null,
}))
mock.module('./postCompactCleanup.js', () => ({
  runPostCompactCleanup: () => {},
}))
mock.module('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
mock.module('../../utils/log.js', () => ({
  logError: () => {},
}))
mock.module('../../utils/errors.js', () => ({
  hasExactErrorMessage: () => false,
}))
mock.module('../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('../api/promptCacheBreakDetection.js', () => ({
  notifyCompaction: () => {},
}))
mock.module('../SessionMemory/sessionMemoryUtils.js', () => ({
  setLastSummarizedMessageId: () => {},
}))

// Import after mocks are set up
const { autoCompactIfNeeded } = await import('./autoCompact.js')

const mockToolUseContext = {
  options: { mainLoopModel: 'claude-sonnet-4-5' },
  agentId: 'test-agent',
} as any

const mockMessages = [] as any[]
const mockCacheSafeParams = {} as any

describe('autoCompactIfNeeded — consecutive refill circuit breaker', () => {
  test('compacts normally when consecutiveRefills is below limit', async () => {
    const tracking = {
      compacted: true,
      turnId: 'turn-id',
      turnCounter: 0,
      consecutiveFailures: 0,
      consecutiveRefills: 2, // below limit of 3
    } as any

    const result = await autoCompactIfNeeded(
      mockMessages,
      mockToolUseContext,
      mockCacheSafeParams,
      undefined,
      tracking,
    )

    expect(result.wasCompacted).toBe(true)
  })

  test('stops compacting when consecutiveRefills reaches limit (circuit breaker)', async () => {
    // tracking reflects an already-compacted context that has been refilled 3 times
    const tracking = {
      compacted: true,
      turnId: 'turn-id',
      turnCounter: 0,
      consecutiveFailures: 0,
      consecutiveRefills: 3, // at limit
    } as any

    const result = await autoCompactIfNeeded(
      mockMessages,
      mockToolUseContext,
      mockCacheSafeParams,
      undefined,
      tracking,
    )

    // Circuit breaker should stop after MAX_CONSECUTIVE_AUTOCOMPACT_REFILLS (3)
    // FAILS before fix (returns wasCompacted: true — loop continues)
    // PASSES after fix (returns wasCompacted: false — circuit breaker trips)
    expect(result.wasCompacted).toBe(false)
  })
})
