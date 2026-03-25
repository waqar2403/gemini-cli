/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loads task manifests from evals/long-context/tasks/ at runtime.
 *
 * Each task directory contains:
 *   manifest.json  — The TaskManifest
 *   gold.patch     — The reference solution patch
 *
 * Tasks can be filtered by difficulty tier, language, or task type
 * via environment variables for targeted evaluation runs.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskManifest } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(__dirname, 'tasks');

export interface LoadOptions {
  difficulty?: ('medium' | 'hard' | 'expert')[];
  languages?: string[];
  taskTypes?: ('bugfix' | 'feature' | 'refactor' | 'migration')[];
  instanceIds?: string[];
  maxTasks?: number;
}

export function loadTasks(options?: LoadOptions): TaskManifest[] {
  if (!existsSync(TASKS_DIR)) {
    console.warn(`  [task-loader] tasks directory not found: ${TASKS_DIR}`);
    return [];
  }

  const taskDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const tasks: TaskManifest[] = [];

  for (const dir of taskDirs) {
    const manifestPath = join(TASKS_DIR, dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest: TaskManifest = JSON.parse(
        readFileSync(manifestPath, 'utf-8'),
      );
      tasks.push(manifest);
    } catch (err) {
      console.warn(
        `  [task-loader] failed to parse ${manifestPath}:`,
        (err as Error).message,
      );
    }
  }

  return applyFilters(tasks, options);
}

function applyFilters(
  tasks: TaskManifest[],
  options?: LoadOptions,
): TaskManifest[] {
  if (!options) return tasks;

  let filtered = tasks;

  if (options.instanceIds?.length) {
    const ids = new Set(options.instanceIds);
    filtered = filtered.filter((t) => ids.has(t.instance_id));
  }

  if (options.difficulty?.length) {
    const tiers = new Set(options.difficulty);
    filtered = filtered.filter((t) =>
      tiers.has(t.classification.difficulty_tier),
    );
  }

  if (options.languages?.length) {
    const langs = new Set(options.languages.map((l) => l.toLowerCase()));
    filtered = filtered.filter((t) =>
      langs.has(t.repo.primary_language.toLowerCase()),
    );
  }

  if (options.taskTypes?.length) {
    const types = new Set(options.taskTypes);
    filtered = filtered.filter((t) => types.has(t.classification.task_type));
  }

  if (options.maxTasks && filtered.length > options.maxTasks) {
    filtered = filtered.slice(0, options.maxTasks);
  }

  return filtered;
}

export function getTaskCount(): number {
  if (!existsSync(TASKS_DIR)) return 0;
  return readdirSync(TASKS_DIR, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  ).length;
}
