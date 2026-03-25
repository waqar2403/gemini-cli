/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LongContextRig — Custom evaluation rig for long-context tasks.
 *
 * Unlike TestRig (which creates fresh temp dirs with inline files), this rig
 * works with real external repositories via bare clone caching and git
 * worktrees. It follows the same CLI-spawn pattern as TestRig.run() but
 * operates on full-scale codebases at a specific commit.
 *
 * Lifecycle:
 *   setup()    → bare clone + worktree at base_commit + home dir with settings
 *   run()      → spawn CLI with the problem statement, collect output + logs
 *   validate() → install deps, run test command, check fail_to_pass/pass_to_pass
 *   cleanup()  → remove worktree + home dir
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { GEMINI_DIR } from '@google/gemini-cli-core';

import { RepoManager } from './repo-manager.js';
import type {
  TaskManifest,
  RunResult,
  ValidationResult,
  FailureMode,
} from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(__dirname, '..', '..', 'bundle', 'gemini.js');
const DEFAULT_TIMEOUT_MS = 1_200_000; // 20 minutes

const repoManager = new RepoManager();

export class LongContextRig {
  private workDir: string | null = null;
  private homeDir: string | null = null;
  private bareCloneDir: string | null = null;
  private activityLogPath: string | null = null;
  private spawnedProcesses: ChildProcess[] = [];

  /**
   * Prepare the workspace: ensure bare clone, create worktree at base_commit,
   * and set up a clean home directory with CLI settings.
   */
  async setup(manifest: TaskManifest): Promise<void> {
    this.bareCloneDir = await repoManager.ensureBareClone(manifest.repo.url);

    this.workDir = mkdtempSync(join(tmpdir(), 'long-ctx-'));
    repoManager.createWorktree(
      this.bareCloneDir,
      manifest.repo.base_commit,
      this.workDir,
    );

    this.homeDir = mkdtempSync(join(tmpdir(), 'long-ctx-home-'));
    this.createSettingsFile();

    const logDir = join(this.homeDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    this.activityLogPath = join(logDir, 'activity.jsonl');
  }

  /**
   * Spawn the Gemini CLI with the task's problem statement as the prompt.
   * Mirrors TestRig.run() — same binary, same approval-mode, same env scrubbing.
   */
  async run(prompt: string, timeoutMs?: number): Promise<RunResult> {
    if (!this.workDir || !this.homeDir) {
      throw new Error('LongContextRig.setup() must be called before run()');
    }

    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(
        'node',
        [BUNDLE_PATH, '--approval-mode=yolo', prompt],
        {
          cwd: this.workDir!,
          stdio: 'pipe',
          env: this.getCleanEnv(),
        },
      );
      this.spawnedProcesses.push(child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (data: string) => {
        stdout += data;
        if (env['VERBOSE'] === 'true') process.stdout.write(data);
      });

      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (data: string) => {
        stderr += data;
        if (env['VERBOSE'] === 'true') process.stderr.write(data);
      });

      child.stdin!.end();

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exit_code: code,
          activity_log_path: this.activityLogPath!,
          duration_ms: Date.now() - startTime,
          timed_out: timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Run the task's test suite in the worktree after the agent has made changes.
   * Returns structured pass/fail results for fail_to_pass and pass_to_pass tests.
   */
  async validate(manifest: TaskManifest): Promise<ValidationResult> {
    if (!this.workDir) {
      throw new Error(
        'LongContextRig.setup() must be called before validate()',
      );
    }

    const installCmd = manifest.environment.install_command;
    if (installCmd) {
      try {
        execSync(installCmd, {
          cwd: this.workDir,
          stdio: 'inherit',
          timeout: 300_000, // 5 min for install
        });
      } catch (err) {
        console.warn(
          `  [long-context-rig] install failed:`,
          (err as Error).message,
        );
      }
    }

    const testCommand = manifest.validation.test_command;
    let testOutput = '';

    try {
      testOutput = execSync(testCommand, {
        cwd: this.workDir,
        encoding: 'utf-8',
        timeout: 300_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const execErr = err as {
        stdout?: string;
        stderr?: string;
      };
      testOutput = (execErr.stdout ?? '') + '\n' + (execErr.stderr ?? '');
    }

    const failToPassResults: Record<string, boolean> = {};
    for (const testId of manifest.validation.fail_to_pass) {
      failToPassResults[testId] = this.checkTestPassed(testOutput, testId);
    }

    const passToPassResults: Record<string, boolean> = {};
    for (const testId of manifest.validation.pass_to_pass) {
      passToPassResults[testId] = this.checkTestPassed(testOutput, testId);
    }

    const allFailToPassGreen = Object.values(failToPassResults).every(Boolean);
    const allPassToPassGreen = Object.values(passToPassResults).every(Boolean);
    const resolved = allFailToPassGreen && allPassToPassGreen;

    let failureMode: FailureMode | undefined;
    if (!resolved) {
      failureMode = this.classifyFailure(
        manifest,
        failToPassResults,
        passToPassResults,
      );
    }

    return {
      resolved,
      fail_to_pass_results: failToPassResults,
      pass_to_pass_results: passToPassResults,
      failure_mode: failureMode,
    };
  }

  /**
   * Remove the worktree and home directory. The bare clone stays cached.
   */
  async cleanup(): Promise<void> {
    for (const child of this.spawnedProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    this.spawnedProcesses = [];

    if (this.bareCloneDir && this.workDir) {
      repoManager.removeWorktree(this.bareCloneDir, this.workDir);
      repoManager.pruneWorktrees(this.bareCloneDir);
    }

    if (this.homeDir && !env['KEEP_OUTPUT']) {
      try {
        rmSync(this.homeDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    this.workDir = null;
    this.homeDir = null;
    this.activityLogPath = null;
  }

  getWorkDir(): string | null {
    return this.workDir;
  }

  getActivityLogPath(): string | null {
    return this.activityLogPath;
  }

  /**
   * Read the agent's activity log as parsed JSON lines.
   */
  readActivityLog(): Record<string, unknown>[] {
    if (!this.activityLogPath || !existsSync(this.activityLogPath)) {
      return [];
    }
    const content = readFileSync(this.activityLogPath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      });
  }

  /**
   * Collect the list of files the agent actually edited (via git diff).
   */
  getEditedFiles(): string[] {
    if (!this.workDir) return [];
    try {
      const diff = execSync('git diff --name-only HEAD', {
        cwd: this.workDir,
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return diff
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private createSettingsFile(): void {
    const geminiDir = join(this.homeDir!, GEMINI_DIR);
    mkdirSync(geminiDir, { recursive: true });

    const settings = {
      general: { enableAutoUpdate: false },
      telemetry: {
        enabled: true,
        target: 'local',
        otlpEndpoint: '',
        outfile: join(this.homeDir!, 'telemetry.log'),
      },
      security: {
        auth: { selectedType: 'gemini-api-key' },
        folderTrust: { enabled: false },
      },
      ui: { useAlternateBuffer: true },
      sandbox: env['GEMINI_SANDBOX']
        ? env['GEMINI_SANDBOX'] !== 'false'
        : undefined,
      ide: { enabled: false, hasSeenNudge: true },
    };

    writeFileSync(
      join(geminiDir, 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
    writeFileSync(
      join(geminiDir, 'state.json'),
      JSON.stringify({ terminalSetupPromptShown: true }, null, 2),
    );
  }

  private getCleanEnv(): Record<string, string | undefined> {
    const cleanEnv: Record<string, string | undefined> = { ...process.env };

    for (const key of Object.keys(cleanEnv)) {
      if (
        (key.startsWith('GEMINI_') || key.startsWith('GOOGLE_GEMINI_')) &&
        key !== 'GEMINI_API_KEY' &&
        key !== 'GOOGLE_API_KEY' &&
        key !== 'GEMINI_MODEL' &&
        key !== 'GEMINI_DEBUG' &&
        !key.startsWith('GEMINI_CLI_ACTIVITY_LOG')
      ) {
        delete cleanEnv[key];
      }
    }

    return {
      ...cleanEnv,
      GEMINI_CLI_HOME: this.homeDir!,
      GEMINI_PTY_INFO: 'child_process',
      GEMINI_CLI_ACTIVITY_LOG_TARGET: this.activityLogPath!,
    };
  }

  private checkTestPassed(testOutput: string, testId: string): boolean {
    const testKey = testId.replace(/::?\*$/, '');
    const lowerKey = testKey.toLowerCase();
    const lines = testOutput.split('\n');

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (!lower.includes(lowerKey)) continue;

      if (/\bfail(ed|ure|ing)?\b/i.test(line)) return false;
      if (/\bpass(ed|ing)?\b/i.test(line)) return true;
      if (/\bok\b/i.test(line)) return true;
    }

    return false;
  }

  private classifyFailure(
    manifest: TaskManifest,
    failToPassResults: Record<string, boolean>,
    passToPassResults: Record<string, boolean>,
  ): FailureMode {
    const editedFiles = this.getEditedFiles();
    const affectedFiles = manifest.gold_patch.affected_files;

    if (editedFiles.length === 0) {
      return 'context_insufficient';
    }

    const editedSet = new Set(editedFiles);
    const affectedSet = new Set(affectedFiles);
    const correctEdits = editedFiles.filter((f) => affectedSet.has(f));
    const wrongEdits = editedFiles.filter((f) => !affectedSet.has(f));

    if (correctEdits.length === 0) {
      return wrongEdits.length > 0
        ? 'wrong_files_targeted'
        : 'complete_hallucination';
    }

    const allPassToPassOk = Object.values(passToPassResults).every(Boolean);
    if (!allPassToPassOk) {
      return 'test_regression';
    }

    const coveredAffected = affectedFiles.filter((f) => editedSet.has(f));
    if (coveredAffected.length < affectedFiles.length) {
      return 'cross_component_miss';
    }

    return 'shallow_fix';
  }
}
