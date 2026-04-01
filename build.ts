#!/usr/bin/env bun
/**
 * build.ts — Claude Code CLI 构建脚本
 *
 * 使用 Bun.build() API + 显式 alias plugin（不依赖 bunfig.toml）。
 * - 构建前清理 dist/
 * - Module alias 解析（内部包 → 本地 stub）
 * - Node.js createRequire 兼容补丁
 */
import { rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { BunPlugin } from "bun";

const ROOT = import.meta.dir;
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src/entrypoints/cli.tsx");

// ── Module aliases (mirrors bunfig.toml [bundle.alias]) ──────
const aliases: Record<string, string> = {
  "bun:bundle":                    "./src/bun-bundle-stub.ts",
  "color-diff-napi":               "./src/native-ts/color-diff/index.ts",
  "@ant/claude-for-chrome-mcp":    "./stubs/claude-for-chrome-mcp.ts",
  "@ant/computer-use-mcp":         "./stubs/computer-use-mcp.ts",
  "@ant/computer-use-mcp/sentinelApps": "./stubs/computer-use-mcp.ts",
  "@ant/computer-use-mcp/types":   "./stubs/computer-use-mcp.ts",
  "@ant/computer-use-swift":       "./stubs/computer-use-swift.ts",
  "modifiers-napi":                "./stubs/modifiers-napi.ts",
};

const aliasPlugin: BunPlugin = {
  name: "alias-resolver",
  setup(build) {
    for (const [name, target] of Object.entries(aliases)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
        path: resolve(ROOT, target),
      }));
    }
  },
};

// ── Clean ────────────────────────────────────────────────────
console.log("Cleaning dist/...");
rmSync(DIST, { recursive: true, force: true });

// ── Define macros ────────────────────────────────────────────
const define: Record<string, string> = {
  "MACRO.VERSION": '"2.1.7-source"',
  "MACRO.PACKAGE_URL": '"@anthropic-ai/claude-code"',
  "MACRO.FEEDBACK_CHANNEL": '"#claude-code-feedback"',
  "MACRO.BUILD_TIME": '""',
  "MACRO.ISSUES_EXPLAINER":
    '"report issues at https://github.com/anthropics/claude-code/issues"',
  "process.env.USER_TYPE": '"external"',
};

// ── External packages ────────────────────────────────────────
const external: string[] = [
  "bun:ffi",
  "@anthropic-ai/foundry-sdk",
  "@azure/identity",
  "sharp",
  "@opentelemetry/exporter-metrics-otlp-grpc",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "@opentelemetry/exporter-prometheus",
  "@opentelemetry/exporter-logs-otlp-grpc",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/exporter-logs-otlp-proto",
  "@opentelemetry/exporter-trace-otlp-grpc",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-trace-otlp-proto",
];

// ── Build ────────────────────────────────────────────────────
console.log("Building...");
const startTime = performance.now();

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: DIST,
  target: "bun",
  define,
  external,
  plugins: [aliasPlugin],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error("  ", log);
  }
  process.exit(1);
}

// ── Post-build: Node.js createRequire compat patch ───────────
const IMPORT_META_REQUIRE = "var __require = import.meta.require;";
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`;

let patched = 0;
try {
  const files = readdirSync(DIST);
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const filePath = join(DIST, file);
    const content = readFileSync(filePath, "utf8");
    if (content.includes(IMPORT_META_REQUIRE)) {
      writeFileSync(filePath, content.replace(IMPORT_META_REQUIRE, COMPAT_REQUIRE));
      patched++;
    }
  }
} catch {
  // Non-fatal
}

const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
console.log(`Build complete in ${elapsed}s — ${result.outputs.length} file(s)${patched > 0 ? `, ${patched} patched for Node.js compat` : ""}`);
