/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Long-Context & Complex Reasoning Evaluation Suite
 *
 * Evaluates the Gemini CLI's ability to navigate, understand, and resolve
 * complex engineering tasks in real, production-scale repositories.
 *
 * Each task:
 *   1. Checks out a real repo at a specific commit via git worktree
 *   2. Presents the agent with a problem statement from a linked issue
 *   3. Lets the agent read code, make edits, and run commands
 *   4. Validates by running the repo's test suite (SWE-bench binary scoring)
 *
 * Uses runEval() from test-helper.ts so results flow through the standard
 * aggregate_evals.js nightly reporting pipeline.
 *
 * Run:
 *   RUN_EVALS=1 npx vitest run evals/long-context/long-context.eval.ts
 *
 * Filter by difficulty:
 *   LONG_CONTEXT_DIFFICULTY=hard RUN_EVALS=1 npx vitest run evals/long-context/long-context.eval.ts
 *
 * Run a single task:
 *   LONG_CONTEXT_TASK=microsoft__vscode-304270 RUN_EVALS=1 npx vitest run evals/long-context/long-context.eval.ts
 */

import { describe, expect } from 'vitest';
import { runEval, type EvalPolicy } from '../test-helper.js';
import { LongContextRig } from './long-context-rig.js';
import { loadTasks, type LoadOptions } from './task-loader.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import type { TaskManifest, ValidationResult } from './schema.js';

const POLICY: EvalPolicy = 'USUALLY_PASSES';
const TASK_TIMEOUT_MS = 1_200_000; // 20 minutes per task

function buildLoadOptions(): LoadOptions {
  const opts: LoadOptions = {};

  const difficulty = process.env['LONG_CONTEXT_DIFFICULTY'];
  if (difficulty) {
    opts.difficulty = difficulty.split(',') as LoadOptions['difficulty'];
  }

  const language = process.env['LONG_CONTEXT_LANGUAGE'];
  if (language) {
    opts.languages = language.split(',');
  }

  const taskType = process.env['LONG_CONTEXT_TASK_TYPE'];
  if (taskType) {
    opts.taskTypes = taskType.split(',') as LoadOptions['taskTypes'];
  }

  const taskId = process.env['LONG_CONTEXT_TASK'];
  if (taskId) {
    opts.instanceIds = taskId.split(',');
  }

  const maxTasks = process.env['LONG_CONTEXT_MAX_TASKS'];
  if (maxTasks) {
    opts.maxTasks = parseInt(maxTasks, 10);
  }

  return opts;
}

function saveResult(
  task: TaskManifest,
  validation: ValidationResult,
  durationMs: number,
): void {
  const resultsDir = join(process.cwd(), 'evals', 'logs', 'long-context');
  mkdirSync(resultsDir, { recursive: true });

  const result = {
    instance_id: task.instance_id,
    repo: task.repo.full_name,
    difficulty: task.classification.difficulty_tier,
    task_type: task.classification.task_type,
    resolved: validation.resolved,
    failure_mode: validation.failure_mode ?? null,
    fail_to_pass: validation.fail_to_pass_results,
    pass_to_pass: validation.pass_to_pass_results,
    duration_ms: durationMs,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(
    join(resultsDir, `${task.instance_id}.json`),
    JSON.stringify(result, null, 2),
  );
}

describe('Long-context evals', () => {
  const tasks = loadTasks(buildLoadOptions());

  if (tasks.length === 0) {
    runEval(POLICY, 'no tasks loaded (check tasks/ directory)', async () => {
      console.warn('No long-context tasks found. Skipping suite.');
    });
    return;
  }

  if (env['VERBOSE'] === 'true') {
    console.log(
      `  [long-context] loaded ${tasks.length} tasks: ` +
        tasks.map((t) => t.instance_id).join(', '),
    );
  }

  for (const task of tasks) {
    const tier = task.classification.difficulty_tier;
    const type = task.classification.task_type;
    const testName = `${task.instance_id} [${tier}/${type}]`;

    runEval(
      POLICY,
      testName,
      async () => {
        const rig = new LongContextRig();
        const startTime = Date.now();
        let validation: ValidationResult | undefined;

        try {
          const verbose = env['VERBOSE'] === 'true';
          if (verbose) {
            console.log(
              `\n  ▶ ${task.instance_id}` +
                ` — ${task.repo.full_name}` +
                ` @ ${task.repo.base_commit.slice(0, 8)}`,
            );
          }

          await rig.setup(task);

          const result = await rig.run(
            task.problem.statement,
            TASK_TIMEOUT_MS,
          );

          if (result.timed_out) {
            validation = {
              resolved: false,
              fail_to_pass_results: {},
              pass_to_pass_results: {},
              failure_mode: 'timeout',
            };
          } else {
            if (verbose) {
              const editedFiles = rig.getEditedFiles();
              console.log(
                `    Agent: ${result.duration_ms}ms,` +
                  ` edited ${editedFiles.length} files` +
                  ` (gold: ${task.gold_patch.files_changed})`,
              );
            }
            validation = await rig.validate(task);
          }

          const durationMs = Date.now() - startTime;
          saveResult(task, validation, durationMs);

          if (verbose) {
            const status = validation.resolved
              ? `RESOLVED in ${durationMs}ms`
              : `FAILED — ${validation.failure_mode ?? 'unknown'}`;
            console.log(`    ${status}`);
          }

          expect(validation.resolved).toBe(true);
        } finally {
          await rig.cleanup();
        }
      },
      TASK_TIMEOUT_MS + 120_000, // Add 2 min buffer for setup/validate/cleanup
    );
  }
});
