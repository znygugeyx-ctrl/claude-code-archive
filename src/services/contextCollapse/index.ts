// Stub: contextCollapse service
export function getStats() {
  return {
    health: {
      emptySpawnWarningEmitted: false,
    },
  }
}

export function subscribe(_callback: () => void): () => void {
  return () => {}
}
