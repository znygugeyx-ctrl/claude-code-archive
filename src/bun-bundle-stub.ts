// Polyfill for bun:bundle - BUDDY feature enabled for April 1st easter egg
export function feature(name: string): boolean {
  return name === 'BUDDY'
}
