#!/usr/bin/env bun
/**
 * build.ts — Claude Code CLI 构建脚本
 *
 * 从 package.json 内联命令提取，增加：
 * - 构建前清理 dist/
 * - 代码分割 (splitting)
 * - Node.js createRequire 兼容补丁
 * - 错误报告和构建耗时
 */
import { rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = import.meta.dir;
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src/entrypoints/cli.tsx");

// ── Clean ────────────────────────────────────────────────────
console.log("Cleaning dist/...");
rmSync(DIST, { recursive: true, force: true });

// ── Define macros (preserved from original package.json) ─────
const define: Record<string, string> = {
  "MACRO.VERSION": '"2.1.7-source"',
  "MACRO.PACKAGE_URL": '"@anthropic-ai/claude-code"',
  "MACRO.FEEDBACK_CHANNEL": '"#claude-code-feedback"',
  "MACRO.BUILD_TIME": '""',
  "MACRO.ISSUES_EXPLAINER":
    '"report issues at https://github.com/anthropics/claude-code/issues"',
  "process.env.USER_TYPE": '"external"',
};

// ── External packages (not bundled) ──────────────────────────
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
