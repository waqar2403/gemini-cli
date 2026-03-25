/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manages bare clone caching and git worktree lifecycle for long-context evals.
 *
 * Strategy:
 *   1. Each repository is cloned once as a bare repo into CACHE_DIR.
 *   2. Per-task worktrees are created from the bare clone at the exact
 *      base_commit, giving the agent an isolated workspace.
 *   3. After validation, the worktree is removed. The bare clone persists
 *      for the next task from the same repo.
 *
 * In CI, CACHE_DIR is stored/restored as a GitHub Actions artifact so that
 * nightly runs only pay the clone cost on the first invocation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { env } from 'node:process';

const DEFAULT_CACHE_DIR = join(
  env['LONG_CONTEXT_CACHE_DIR'] || join(process.cwd(), '.long-context-cache'),
);

const CLONE_TIMEOUT = 600_000; // 10 minutes for initial clone
const FETCH_TIMEOUT = 120_000; // 2 minutes for incremental fetch

export class RepoManager {
  private readonly cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? DEFAULT_CACHE_DIR;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Returns the path to a bare clone of the given repo, creating it if needed.
   * Subsequent calls for the same repo return immediately.
   */
  async ensureBareClone(repoUrl: string): Promise<string> {
    const repoHash = createHash('sha256')
      .update(repoUrl)
      .digest('hex')
      .slice(0, 12);
    const bareDir = join(this.cacheDir, `${repoHash}.git`);

    if (!existsSync(bareDir)) {
      console.log(
        `  [repo-manager] cloning ${repoUrl} → ${bareDir}`,
      );
      execFileSync(
        'git',
        ['clone', '--bare', repoUrl, bareDir],
        { stdio: 'inherit', timeout: CLONE_TIMEOUT },
      );
    } else {
      console.log(
        `  [repo-manager] fetching updates for ${bareDir}`,
      );
      try {
        execFileSync('git', ['fetch', '--all', '--prune'], {
          cwd: bareDir,
          stdio: 'inherit',
          timeout: FETCH_TIMEOUT,
        });
      } catch (err) {
        console.warn(
          '  [repo-manager] fetch failed (non-fatal):',
          (err as Error).message,
        );
      }
    }

    return bareDir;
  }

  /**
   * Creates a detached worktree at the given commit from a bare clone.
   * Returns the absolute path to the worktree directory.
   */
  createWorktree(bareDir: string, commit: string, workDir: string): void {
    mkdirSync(workDir, { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '--detach', workDir, commit],
      { cwd: bareDir, stdio: 'inherit', timeout: 60_000 },
    );
  }

  /**
   * Removes a previously created worktree.
   */
  removeWorktree(bareDir: string, workDir: string): void {
    try {
      execFileSync(
        'git',
        ['worktree', 'remove', '--force', workDir],
        { cwd: bareDir, stdio: 'inherit', timeout: 30_000 },
      );
    } catch (err) {
      console.warn(
        `  [repo-manager] worktree removal failed (non-fatal):`,
        (err as Error).message,
      );
    }
  }

  /**
   * Prunes stale worktree references from a bare clone.
   */
  pruneWorktrees(bareDir: string): void {
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: bareDir,
        stdio: 'inherit',
        timeout: 10_000,
      });
    } catch {
      // Non-critical
    }
  }

  getCacheDir(): string {
    return this.cacheDir;
  }
}
