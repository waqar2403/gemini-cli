# Long-Context & Complex Reasoning Evaluation Suite

Evaluates the Gemini CLI's ability to navigate, understand, and resolve complex
engineering tasks in real, production-scale open-source repositories.

## What makes this different from behavioral evals

| Dimension | Behavioral Evals (`evals/*.eval.ts`) | Long-Context Evals |
|-----------|--------------------------------------|-------------------|
| Codebase | 2–5 inline files | Real repos (VS Code, TiDB, Deno, ...) |
| Complexity | Single-file fixes | Multi-file, cross-component (avg 12.3 files) |
| Context | Minimal | Full repository at a specific commit |
| Rig | `TestRig` (temp dir + inline files) | `LongContextRig` (bare clone + worktree) |
| Scoring | Assertion-based | SWE-bench binary (fail\_to\_pass / pass\_to\_pass) |
| Timeout | 5 min | 20 min |

## Dataset

28 validated tasks across 6 languages from 12 production-scale repositories:

- **Go** (8): gitea, tidb, etcd, syncthing
- **JavaScript** (6): mermaid, yt-dlp
- **TypeScript** (5): vscode, mermaid, openclaw
- **Python** (5): home-assistant, ragflow
- **Java** (3): keycloak
- **Rust** (1): deno

Difficulty distribution: 13 medium · 10 hard · 5 expert

## Architecture

```
tasks/{instance_id}/
  manifest.json    # Task definition (repo, problem, environment, validation)
  gold.patch       # Reference solution

LongContextRig
  setup()    → bare clone cache + git worktree at base_commit
  run()      → spawn gemini CLI with problem statement
  validate() → run test suite, check fail_to_pass / pass_to_pass
  cleanup()  → remove worktree (bare clone stays cached)

long-context.eval.ts
  Uses runEval() from test-helper.ts
  → Results appear in aggregate_evals.js nightly summary
```

## Running

### All long-context evals

```bash
RUN_EVALS=1 npx vitest run evals/long-context/long-context.eval.ts
```

### Single task

```bash
LONG_CONTEXT_TASK=microsoft__vscode-304270 RUN_EVALS=1 \
  npx vitest run evals/long-context/long-context.eval.ts
```

### Filter by difficulty

```bash
LONG_CONTEXT_DIFFICULTY=medium RUN_EVALS=1 \
  npx vitest run evals/long-context/long-context.eval.ts
```

### Filter by language

```bash
LONG_CONTEXT_LANGUAGE=Go RUN_EVALS=1 \
  npx vitest run evals/long-context/long-context.eval.ts
```

### Analyze results

```bash
npx tsx evals/long-context/analyze-failures.ts
```

## Environment variables

| Variable | Description | Example |
|----------|-------------|---------|
| `LONG_CONTEXT_CACHE_DIR` | Bare clone cache location | `/tmp/lc-cache` |
| `LONG_CONTEXT_TASK` | Run specific task(s) | `microsoft__vscode-304270` |
| `LONG_CONTEXT_DIFFICULTY` | Filter by difficulty | `hard,expert` |
| `LONG_CONTEXT_LANGUAGE` | Filter by language | `Go,Python` |
| `LONG_CONTEXT_TASK_TYPE` | Filter by task type | `bugfix` |
| `LONG_CONTEXT_MAX_TASKS` | Limit number of tasks | `5` |

## Adding new tasks

1. Create a directory under `tasks/` named `{owner}__{repo}-{pr_number}`
2. Add `manifest.json` following the schema in `schema.ts`
3. Add `gold.patch` (the reference solution diff)
4. Ensure the task's test suite passes at `base_commit` after applying `gold.patch`

### Manifest requirements

- `instance_id` must match SWE-bench format: `owner__repo-PR#`
- `base_commit` must be a valid 40-character SHA
- `validation.fail_to_pass` must list at least one test identifier
- `environment.install_command` and `validation.test_command` must work at `base_commit`
- `contamination.pr_merged_at` should be after January 2026 for training cutoff safety

## Failure mode taxonomy

When a task fails, the rig classifies the failure into one of 7 categories:

| Mode | Meaning |
|------|---------|
| `context_insufficient` | Agent made no edits (didn't read enough code) |
| `wrong_files_targeted` | Agent edited files not in the gold patch |
| `shallow_fix` | Agent edited correct files but fix is structurally wrong |
| `cross_component_miss` | Agent fixed some affected files but not all |
| `test_regression` | fail\_to\_pass passes but pass\_to\_pass breaks |
| `timeout` | Agent exceeded 20-minute limit |
| `complete_hallucination` | Changes have no structural resemblance to gold patch |

## CI integration

Long-context evals use `runEval('USUALLY_PASSES', ...)` from `test-helper.ts`,
so they only run when `RUN_EVALS=1` is set (nightly builds). Results flow
through `aggregate_evals.js` into the standard nightly summary table.

The bare clone cache (`LONG_CONTEXT_CACHE_DIR`) should be stored as a GitHub
Actions artifact to avoid re-cloning on every nightly run.
