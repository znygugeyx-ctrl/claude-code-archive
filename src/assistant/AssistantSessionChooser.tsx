// Stub: AssistantSessionChooser is Anthropic-internal
import React from 'react'

interface Props {
  sessions: unknown[]
  onSelect: (id: string | null) => void
  onCancel: () => void
}

export function AssistantSessionChooser({ onCancel }: Props): React.ReactElement {
  onCancel()
  return React.createElement(React.Fragment, null)
}
