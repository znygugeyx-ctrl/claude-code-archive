#!/usr/bin/env bun
/**
 * build.ts — Claude Code CLI 构建脚本
 *
 * 使用 bun build CLI（读取 bunfig.toml 的 bundle.alias）而非 Bun.build() API，
 * 确保本地和 CI 行为一致。增加：
 * - 构建前清理 dist/
 * - Node.js createRequire 兼容补丁
 * - 错误报告和构建耗时
 */
import { rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = import.meta.dir;
const DIST = join(ROOT, "dist");

// ── Clean ────────────────────────────────────────────────────
console.log("Cleaning dist/...");
rmSync(DIST, { recursive: true, force: true });

// ── Build via CLI (reads bunfig.toml aliases) ────────────────
console.log("Building...");
const startTime = performance.now();

const args = [
  "build", "src/entrypoints/cli.tsx",
  "--outdir", "dist",
  "--target", "bun",
  "--define", 'MACRO.VERSION="2.1.7-source"',
  "--define", 'MACRO.PACKAGE_URL="@anthropic-ai/claude-code"',
  "--define", 'MACRO.FEEDBACK_CHANNEL="#claude-code-feedback"',
  "--define", 'MACRO.BUILD_TIME=""',
  "--define", 'MACRO.ISSUES_EXPLAINER="report issues at https://github.com/anthropics/claude-code/issues"',
  "--define", 'process.env.USER_TYPE="external"',
  "--external", "bun:ffi",
  "--external", "@anthropic-ai/foundry-sdk",
  "--external", "@azure/identity",
  "--external", "sharp",
  "--external", "@opentelemetry/exporter-metrics-otlp-grpc",
  "--external", "@opentelemetry/exporter-metrics-otlp-http",
  "--external", "@opentelemetry/exporter-metrics-otlp-proto",
  "--external", "@opentelemetry/exporter-prometheus",
  "--external", "@opentelemetry/exporter-logs-otlp-grpc",
  "--external", "@opentelemetry/exporter-logs-otlp-http",
  "--external", "@opentelemetry/exporter-logs-otlp-proto",
  "--external", "@opentelemetry/exporter-trace-otlp-grpc",
  "--external", "@opentelemetry/exporter-trace-otlp-http",
  "--external", "@opentelemetry/exporter-trace-otlp-proto",
];

const result = spawnSync("bun", args, { cwd: ROOT, stdio: "inherit" });

if (result.status !== 0) {
  console.error("Build failed");
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
console.log(`Build complete in ${elapsed}s${patched > 0 ? `, ${patched} patched for Node.js compat` : ""}`);
