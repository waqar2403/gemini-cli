/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Post-hoc failure analysis script for long-context eval results.
 *
 * Reads per-task result JSONs from evals/logs/long-context/ and produces:
 *   1. A summary table (resolution rate by difficulty, model, language)
 *   2. Failure mode distribution
 *   3. Detailed per-task breakdown
 *
 * Usage:
 *   npx tsx evals/long-context/analyze-failures.ts [--results-dir evals/logs/long-context]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface TaskResult {
  instance_id: string;
  repo: string;
  difficulty: string;
  task_type: string;
  resolved: boolean;
  failure_mode: string | null;
  fail_to_pass: Record<string, boolean>;
  pass_to_pass: Record<string, boolean>;
  duration_ms: number;
  timestamp: string;
}

function loadResults(resultsDir: string): TaskResult[] {
  if (!existsSync(resultsDir)) {
    console.error(`Results directory not found: ${resultsDir}`);
    return [];
  }

  return readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(
          readFileSync(join(resultsDir, f), 'utf-8'),
        ) as TaskResult;
      } catch {
        return null;
      }
    })
    .filter((r): r is TaskResult => r !== null);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function resolutionRate(results: TaskResult[]): string {
  if (results.length === 0) return 'N/A';
  const resolved = results.filter((r) => r.resolved).length;
  const pct = ((resolved / results.length) * 100).toFixed(1);
  return `${resolved}/${results.length} (${pct}%)`;
}

function generateReport(results: TaskResult[]): string {
  const lines: string[] = [];

  lines.push('# Long-Context Evaluation — Failure Analysis Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total tasks evaluated: ${results.length}`);
  lines.push(
    `Overall resolution rate: ${resolutionRate(results)}`,
  );
  lines.push('');

  // By Difficulty
  lines.push('## Resolution Rate by Difficulty');
  lines.push('');
  lines.push('| Difficulty | Tasks | Resolved | Rate |');
  lines.push('|-----------|-------|----------|------|');
  const byDiff = [...groupBy(results, (r) => r.difficulty)].sort(
    (a, b) => a[0].localeCompare(b[0]),
  );
  for (const [diff, group] of byDiff) {
    const resolved = group.filter((r) => r.resolved).length;
    const pct = ((resolved / group.length) * 100).toFixed(1);
    lines.push(
      `| ${diff} | ${group.length} | ${resolved} | ${pct}% |`,
    );
  }
  lines.push('');

  // By Task Type
  lines.push('## Resolution Rate by Task Type');
  lines.push('');
  lines.push('| Type | Tasks | Resolved | Rate |');
  lines.push('|------|-------|----------|------|');
  const byType = [...groupBy(results, (r) => r.task_type)].sort(
    (a, b) => a[0].localeCompare(b[0]),
  );
  for (const [type, group] of byType) {
    const resolved = group.filter((r) => r.resolved).length;
    const pct = ((resolved / group.length) * 100).toFixed(1);
    lines.push(
      `| ${type} | ${group.length} | ${resolved} | ${pct}% |`,
    );
  }
  lines.push('');

  // By Language (extracted from repo)
  lines.push('## Resolution Rate by Repository');
  lines.push('');
  lines.push('| Repository | Tasks | Resolved | Rate |');
  lines.push('|-----------|-------|----------|------|');
  const byRepo = [...groupBy(results, (r) => r.repo)].sort(
    (a, b) => a[0].localeCompare(b[0]),
  );
  for (const [repo, group] of byRepo) {
    const resolved = group.filter((r) => r.resolved).length;
    const pct = ((resolved / group.length) * 100).toFixed(1);
    lines.push(
      `| ${repo} | ${group.length} | ${resolved} | ${pct}% |`,
    );
  }
  lines.push('');

  // Failure Mode Distribution
  const failed = results.filter((r) => !r.resolved);
  lines.push('## Failure Mode Distribution');
  lines.push('');
  if (failed.length > 0) {
    lines.push('| Failure Mode | Count | % of Failures |');
    lines.push('|-------------|-------|--------------|');
    const byMode = [
      ...groupBy(failed, (r) => r.failure_mode ?? 'unknown'),
    ].sort((a, b) => b[1].length - a[1].length);
    for (const [mode, group] of byMode) {
      const pct = ((group.length / failed.length) * 100).toFixed(1);
      lines.push(`| ${mode} | ${group.length} | ${pct}% |`);
    }
  } else {
    lines.push('All tasks resolved successfully.');
  }
  lines.push('');

  // Per-task Details
  lines.push('## Per-Task Results');
  lines.push('');
  lines.push(
    '| Instance ID | Difficulty | Type | Resolved | Failure Mode | Duration |',
  );
  lines.push(
    '|------------|-----------|------|----------|-------------|----------|',
  );
  for (const r of results.sort((a, b) =>
    a.instance_id.localeCompare(b.instance_id),
  )) {
    const duration = `${(r.duration_ms / 1000).toFixed(0)}s`;
    const resolved = r.resolved ? 'YES' : 'NO';
    const mode = r.failure_mode ?? '—';
    lines.push(
      `| ${r.instance_id} | ${r.difficulty} | ` +
        `${r.task_type} | ${resolved} | ${mode} | ${duration} |`,
    );
  }

  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let resultsDir = join(process.cwd(), 'evals', 'logs', 'long-context');

  const dirIdx = args.indexOf('--results-dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    resultsDir = args[dirIdx + 1];
  }

  const results = loadResults(resultsDir);
  if (results.length === 0) {
    console.log('No results found. Run the long-context evals first.');
    process.exit(0);
  }

  const report = generateReport(results);
  console.log(report);

  const outputPath = join(resultsDir, 'analysis-report.md');
  writeFileSync(outputPath, report);
  console.log(`\nReport saved to ${outputPath}`);
}

main();
