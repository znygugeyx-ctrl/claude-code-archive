// Stub: ConnectorText is an Anthropic-internal content block type
export type ConnectorTextBlock = {
  type: 'connector_text'
  text: string
}

export function isConnectorTextBlock(block: unknown): block is ConnectorTextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as Record<string, unknown>).type === 'connector_text'
  )
}
