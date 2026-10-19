#!/usr/bin/env node
// Runs the OpenClaw Plugin Inspector (the checker behind ClawHub's package
// validation) on exactly the files `npm pack` would publish, against the
// OpenClaw host installed as a dev dependency. Fails on any breakage, warning,
// or issue, including deprecated Plugin SDK APIs (`sdk-deprecated-api`).
//
// Exit codes: 0 clean, 1 findings, 2 could not run. Run `npm run build` first.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const inspectorCli = join(root, "node_modules", "@openclaw", "plugin-inspector", "src", "cli.js");
const openclawHost = join(root, "node_modules", "openclaw");

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

if (!existsSync(inspectorCli) || !existsSync(openclawHost)) {
  fail(2, "Install dev dependencies first (npm ci).");
}
if (!existsSync(join(root, "dist", "index.js"))) {
  fail(2, "dist/index.js not found. Run `npm run build` first.");
}

// The exact file list `npm pack` would publish.
const npmCli = process.env.npm_execpath;
const pack = npmCli
  ? spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" })
  : spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: true });
if (pack.status !== 0) {
  fail(2, `npm pack --dry-run failed:\n${pack.stderr}`);
}
const files = JSON.parse(pack.stdout)[0]?.files?.map((file) => file.path) ?? [];
if (files.length === 0) {
  fail(2, "npm pack --dry-run listed no files.");
}

const work = mkdtempSync(join(tmpdir(), "empiriolabs-openclaw-inspect-"));
const packageDir = join(work, "package");
const reportDir = join(work, "report");
try {
  for (const file of files) {
    cpSync(join(root, file), join(packageDir, file), { recursive: false, force: true });
  }
  const run = spawnSync(
    process.execPath,
    [inspectorCli, "check", "--plugin-root", packageDir, "--openclaw", openclawHost, "--out", reportDir, "--json"],
    { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0 && !run.stdout) {
    fail(2, `Plugin Inspector failed to run:\n${run.stderr}`);
  }
  const report = JSON.parse(run.stdout);
  const target = report.targetOpenClaw ?? {};
  if (target.status !== "ok") {
    fail(2, `Plugin Inspector could not read the OpenClaw host (status ${target.status}).`);
  }
  const summary = report.summary ?? {};
  const findings = [...(report.breakages ?? []), ...(report.warnings ?? []), ...(report.issues ?? [])];
  console.log(
    `Plugin Inspector ${JSON.parse(readFileSync(join(dirname(inspectorCli), "..", "package.json"), "utf8")).version} ` +
      `against OpenClaw ${target.version}: ${report.status}; ${files.length} files; ` +
      `breakages ${summary.breakageCount ?? 0}, warnings ${summary.warningCount ?? 0}, issues ${summary.issueCount ?? 0}, ` +
      `deprecations ${summary.deprecationWarningCount ?? 0}`,
  );
  if (findings.length > 0 || (summary.breakageCount ?? 0) + (summary.warningCount ?? 0) + (summary.issueCount ?? 0) > 0) {
    for (const finding of findings) {
      console.error(`- ${finding.code ?? finding.id ?? "finding"}: ${finding.message ?? finding.title ?? JSON.stringify(finding)}`);
    }
    process.exit(1);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
