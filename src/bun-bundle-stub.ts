// Polyfill for bun:bundle - feature() always returns false in external builds
export function feature(_name: string): false {
  return false
}
