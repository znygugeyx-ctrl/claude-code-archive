// Types for file persistence
export const DEFAULT_UPLOAD_CONCURRENCY = 5
export const FILE_COUNT_LIMIT = 1000
export const OUTPUTS_SUBDIR = 'outputs'

export type FailedPersistence = {
  file: string
  error: Error
}

export type FilesPersistedEventData = {
  files: string[]
  failed: FailedPersistence[]
}

export type PersistedFile = {
  path: string
  size: number
}

export type TurnStartTime = {
  turnId: string
  startTime: number
}
