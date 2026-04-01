#!/usr/bin/env bun
/**
 * health-check.ts — 项目健康仪表盘
 * 检查依赖、构建、测试、lint、hooks 状态
 */
import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];

function run(cmd: string, args: string[], cwd = ROOT) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000 });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// 1. Dependencies
if (existsSync(join(ROOT, "node_modules"))) {
  checks.push({ name: "Dependencies", status: "pass", detail: "node_modules/ exists" });
} else {
  checks.push({ name: "Dependencies", status: "fail", detail: "missing — run: bun install" });
}

// 2. Build output
const distCli = join(ROOT, "dist", "cli.js");
if (existsSync(distCli)) {
  const sizeMB = (statSync(distCli).size / 1024 / 1024).toFixed(1);
  checks.push({ name: "Build output", status: "pass", detail: `dist/cli.js (${sizeMB} MB)` });
} else {
  checks.push({ name: "Build output", status: "warn", detail: "missing — run: bun run build" });
}

// 3. TypeScript config
if (existsSync(join(ROOT, "tsconfig.json"))) {
  checks.push({ name: "TypeScript", status: "pass", detail: "tsconfig.json exists" });
} else {
  checks.push({ name: "TypeScript", status: "fail", detail: "tsconfig.json missing" });
}

// 4. Linter
if (existsSync(join(ROOT, "biome.json"))) {
  const lint = run("bunx", ["@biomejs/biome", "lint", "./src"]);
  if (lint.ok) {
    checks.push({ name: "Linter", status: "pass", detail: "Biome: 0 errors" });
  } else {
    const errMatch = lint.stderr.match(/Found (\d+) error/);
    const warnMatch = lint.stderr.match(/Found (\d+) warning/);
    const errs = errMatch ? errMatch[1] : "0";
    const warns = warnMatch ? warnMatch[1] : "0";
    const status = errs !== "0" ? "warn" : "pass";
    checks.push({ name: "Linter", status, detail: `Biome: ${errs} errors, ${warns} warnings` });
  }
} else {
  checks.push({ name: "Linter", status: "warn", detail: "biome.json not found" });
}

// 5. Tests
const testResult = run("bun", ["test"]);
if (testResult.ok) {
  const passMatch = testResult.stdout.match(/(\d+) pass/);
  checks.push({ name: "Tests", status: "pass", detail: `${passMatch?.[1] ?? "?"} tests pass` });
} else {
  checks.push({ name: "Tests", status: "fail", detail: "tests failed" });
}

// 6. Git status
const gitStatus = run("git", ["status", "--porcelain"]);
if (gitStatus.ok) {
  const lines = gitStatus.stdout.split("\n").filter(Boolean);
  if (lines.length === 0) {
    checks.push({ name: "Git", status: "pass", detail: "working tree clean" });
  } else {
    checks.push({ name: "Git", status: "warn", detail: `${lines.length} uncommitted change(s)` });
  }
}

// 7. Security hooks
const hookExists = existsSync(join(ROOT, ".git", "hooks", "pre-commit"));
const scriptExists = existsSync(join(ROOT, ".claude", "hooks", "security-check.sh"));
if (hookExists && scriptExists) {
  checks.push({ name: "Security hooks", status: "pass", detail: "pre-commit + security-check.sh" });
} else {
  const missing = [];
  if (!hookExists) missing.push("pre-commit");
  if (!scriptExists) missing.push("security-check.sh");
  checks.push({ name: "Security hooks", status: "warn", detail: `missing: ${missing.join(", ")}` });
}

// Report
const W = 58;
console.log("");
console.log("┌" + "─".repeat(W) + "┐");
console.log("│" + "  Project Health Dashboard".padEnd(W) + "│");
console.log("├" + "─".repeat(W) + "┤");

const icons = { pass: " ✓ ", warn: " ! ", fail: " ✗ " };
for (const c of checks) {
  const line = `${icons[c.status]} ${c.name.padEnd(18)} ${c.detail}`;
  console.log("│" + line.slice(0, W).padEnd(W) + "│");
}

console.log("└" + "─".repeat(W) + "┘");

const fails = checks.filter((c) => c.status === "fail").length;
const warns = checks.filter((c) => c.status === "warn").length;
console.log(`\n${checks.length - fails - warns} pass, ${warns} warn, ${fails} fail\n`);

if (fails > 0) process.exit(1);
