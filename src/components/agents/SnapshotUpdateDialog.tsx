// Stub: SnapshotUpdateDialog is Anthropic-internal
import React from 'react'

interface Props {
  agentType: string
  scope: string
  snapshotTimestamp: string
  onComplete: (result: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({ onCancel }: Props): React.ReactElement {
  onCancel()
  return React.createElement(React.Fragment, null)
}
