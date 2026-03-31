#!/usr/bin/env bun
/**
 * Auto-create stub files for all missing modules in the build.
 * Runs bun build, parses errors, creates stubs, repeats until success.
 */
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const BUILD_CMD = 'bun'
const BUILD_ARGS = [
  'build', 'src/entrypoints/cli.tsx',
  '--outfile', 'dist/cli.js',
  '--target', 'bun',
  '--define', 'MACRO.VERSION="2.1.7-source"',
  '--define', 'MACRO.PACKAGE_URL="@anthropic-ai/claude-code"',
  '--define', 'MACRO.FEEDBACK_CHANNEL="#claude-code-feedback"',
  '--define', 'MACRO.BUILD_TIME=""',
  '--define', 'MACRO.ISSUES_EXPLAINER="report issues at https://github.com/anthropics/claude-code/issues"',
  '--define', 'process.env.USER_TYPE="external"',
  '--external', 'bun:bundle',
  '--external', 'bun:ffi',
  '--external', '@anthropic-ai/foundry-sdk',
  '--external', '@azure/identity',
  '--external', 'sharp',
  '--external', '@opentelemetry/exporter-metrics-otlp-grpc',
  '--external', '@opentelemetry/exporter-metrics-otlp-http',
  '--external', '@opentelemetry/exporter-metrics-otlp-proto',
  '--external', '@opentelemetry/exporter-prometheus',
  '--external', '@opentelemetry/exporter-logs-otlp-grpc',
  '--external', '@opentelemetry/exporter-logs-otlp-http',
  '--external', '@opentelemetry/exporter-logs-otlp-proto',
  '--external', '@opentelemetry/exporter-trace-otlp-grpc',
  '--external', '@opentelemetry/exporter-trace-otlp-http',
  '--external', '@opentelemetry/exporter-trace-otlp-proto',
]

function generateStub(filePath: string): string {
  const ext = filePath.split('.').pop()

  // Text/markdown files - return empty string
  if (ext === 'txt' || ext === 'md') {
    return '// stub content\n'
  }

  // Derive export name from filename (e.g. FooTool.ts -> FooTool)
  const base = filePath.split('/').pop()!.replace(/\.(ts|tsx|js)$/, '')
  const exportName = base.charAt(0).toUpperCase() + base.slice(1)

  return `// Stub: ${base} - Anthropic-internal or feature-flagged module
export const ${exportName} = {
  name: '${exportName}',
  description: 'stub',
}

export async function ${base}Main(_args?: unknown): Promise<void> {
  throw new Error('${base} is not available in external builds')
}

export default null
`
}

function createNpmStub(pkg: string): void {
  const dir = join(ROOT, 'node_modules', pkg)
  mkdirSync(dir, { recursive: true })
  const pkgJson = {
    name: pkg,
    version: '0.0.1',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2))
  writeFileSync(join(dir, 'index.js'), `// Stub: ${pkg} - Anthropic-internal\nexport default {}\n`)
  console.log(`  [npm stub] ${pkg}`)
}

function parseErrors(output: string): { srcFiles: Set<string>, npmPkgs: Set<string> } {
  const srcFiles = new Set<string>()
  const npmPkgs = new Set<string>()

  // Match: "Could not resolve: "path"" with source file context
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Pattern: error: Could not resolve: "X"
    const resolveMatch = line.match(/error: Could not resolve: "([^"]+)"/)
    if (!resolveMatch) continue
    const target = resolveMatch[1]

    // Look ahead for "at /path/to/src/file.ts:line:col"
    const atLine = lines[i + 1] || ''
    const atMatch = atLine.match(/at (.+?):\d+:\d+/)
    const sourceFile = atMatch ? atMatch[1] : ''

    if (target.startsWith('@') || !target.startsWith('.')) {
      // npm package
      if (!target.startsWith('node:') && !target.startsWith('bun:')) {
        npmPkgs.add(target)
      }
    } else if (sourceFile.includes('/src/')) {
      // Relative import - resolve from source file location
      const sourceDir = dirname(sourceFile)
      // Convert .js to .ts for source resolution
      const targetTs = target.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx')
      const absPath = resolve(sourceDir, targetTs)
      if (absPath.includes('/src/')) {
        srcFiles.add(absPath)
      }
    }
  }

  return { srcFiles, npmPkgs }
}

let iteration = 0
const maxIterations = 20
const createdFiles = new Set<string>()

while (iteration < maxIterations) {
  iteration++
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Build attempt #${iteration}`)
  console.log('='.repeat(60))

  const result = spawnSync(BUILD_CMD, BUILD_ARGS, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const output = (result.stdout || '') + (result.stderr || '')

  if (result.status === 0) {
    console.log('✅ Build succeeded!')
    console.log(`Created ${createdFiles.size} stub files total.`)
    process.exit(0)
  }

  const { srcFiles, npmPkgs } = parseErrors(output)

  if (srcFiles.size === 0 && npmPkgs.size === 0) {
    console.error('Build failed but no "Could not resolve" errors found.')
    console.error('Raw build output:')
    console.error(output.slice(0, 3000))
    process.exit(1)
  }

  // Create npm stubs (check full package path, not just scope)
  for (const pkg of npmPkgs) {
    const pkgDir = pkg.startsWith('@')
      ? join(ROOT, 'node_modules', ...pkg.split('/').slice(0, 2))
      : join(ROOT, 'node_modules', pkg.split('/')[0])
    if (!existsSync(pkgDir)) {
      const stubName = pkg.startsWith('@') ? pkg.split('/').slice(0,2).join('/') : pkg.split('/')[0]
      createNpmStub(stubName)
    }
  }

  // Create src stubs
  let created = 0
  for (const absPath of srcFiles) {
    if (createdFiles.has(absPath)) continue
    if (existsSync(absPath)) continue

    const dir = dirname(absPath)
    mkdirSync(dir, { recursive: true })

    const ext = absPath.endsWith('.tsx') ? '.tsx' : '.ts'
    const finalPath = absPath.endsWith('.ts') || absPath.endsWith('.tsx') ? absPath : absPath + ext

    const content = generateStub(finalPath)
    writeFileSync(finalPath, content)
    createdFiles.add(absPath)
    created++
    console.log(`  [stub] ${finalPath.replace(ROOT + '/', '')}`)
  }

  if (created === 0 && npmPkgs.size === 0) {
    console.error('No new stubs created and no new npm packages. Build output:')
    console.error(output.slice(0, 3000))
    process.exit(1)
  }
  if (created === 0) {
    // npm packages detected but all already exist - might be export mismatch
    console.error(`Detected npm packages (${[...npmPkgs].join(', ')}) but all already have stubs.`)
    console.error('Build output:')
    console.error(output.slice(0, 3000))
    process.exit(1)
  }

  console.log(`Created ${created} new stubs, retrying build...`)
}

console.error(`Max iterations (${maxIterations}) reached without success.`)
process.exit(1)
