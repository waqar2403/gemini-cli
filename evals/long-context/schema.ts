/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Schema types for the Long-Context & Complex Reasoning evaluation dataset.
 *
 * Each task is a self-contained manifest pointing to a real open-source
 * repository at a specific commit. The agent must read the problem statement,
 * navigate the codebase, and produce a patch that makes fail_to_pass tests
 * pass while keeping pass_to_pass tests green.
 *
 * instance_id format follows SWE-bench convention: owner__repo-PR#
 */

export interface TaskManifest {
  schema_version: number;
  instance_id: string;
  repo: RepoInfo;
  problem: ProblemInfo;
  gold_patch: GoldPatchInfo;
  provenance: ProvenanceInfo;
  environment: EnvironmentInfo;
  validation: ValidationInfo;
  context?: ContextInfo;
  classification: ClassificationInfo;
  contamination: ContaminationInfo;
  difficulty_signals: DifficultySignals;
}

export interface RepoInfo {
  full_name: string;
  url: string;
  base_commit: string;
  primary_language: string;
  languages: string[];
  size_kb?: number;
}

export interface ProblemInfo {
  statement: string;
  source: 'issue' | 'pr_body' | 'synthetic';
  source_url: string;
  source_id: number;
}

export interface GoldPatchInfo {
  patch_file: string;
  affected_files: string[];
  affected_directories?: string[];
  files_changed: number;
  directories_changed: number;
  insertions: number;
  deletions: number;
  test_files_changed?: string[];
  source_files_changed?: string[];
}

export interface ProvenanceInfo {
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_merged_at: string;
  issue_number: number | null;
  issue_url: string | null;
  issue_created_at: string | null;
  issue_labels?: string[];
}

export interface EnvironmentInfo {
  runtime: string;
  runtime_version: string;
  package_manager: string;
  install_command: string;
  build_command?: string;
  setup_commands?: string[];
  env_vars?: Record<string, string>;
  docker_image?: string | null;
  timeout_seconds: number;
}

export interface ValidationInfo {
  test_command: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
}

export interface ContextInfo {
  required_files: string[];
  dependency_chain?: string[];
  min_context_tokens: number;
  total_repo_files?: number;
  total_repo_loc?: number;
}

export interface ClassificationInfo {
  task_type: 'bugfix' | 'feature' | 'refactor' | 'migration';
  difficulty_tier: 'medium' | 'hard' | 'expert';
  reasoning_types: string[];
  description?: string;
}

export interface ContaminationInfo {
  issue_created_at?: string;
  pr_merged_at: string;
  training_cutoff_safe: boolean;
  solution_in_issue: boolean;
  solution_in_pr_comments?: boolean;
  solution_in_commit_message?: boolean;
  synthetic: boolean;
}

export interface DifficultySignals {
  files_changed: number;
  directories_changed: number;
  cross_package: boolean;
  insertions?: number;
  deletions?: number;
  dependency_depth?: number;
  requires_test_understanding?: boolean;
  requires_config_understanding?: boolean;
  estimated_human_hours: number;
}

export type FailureMode =
  | 'context_insufficient'
  | 'wrong_files_targeted'
  | 'shallow_fix'
  | 'cross_component_miss'
  | 'test_regression'
  | 'timeout'
  | 'complete_hallucination';

export interface ValidationResult {
  resolved: boolean;
  fail_to_pass_results: Record<string, boolean>;
  pass_to_pass_results: Record<string, boolean>;
  failure_mode?: FailureMode;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  activity_log_path: string;
  duration_ms: number;
  timed_out: boolean;
}
