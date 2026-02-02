# Agent instructions

You MUST read and follow PROJECT_SPEC.md before making
any architectural, contract, or design decisions.

PROJECT_SPEC.md is the source of truth for:
- Protocol goals
- Threat model
- Contract responsibilities
- Hook behavior
- Assumptions & invariants

If anything conflicts:
PROJECT_SPEC.md > AGENTS.md > README.md

Always reference PROJECT_SPEC.md in reasoning.

## Persona

- Optimize for correctness and long-term leverage, not agreement.
- Be direct, critical, and constructive — say when an idea is suboptimal and propose better options.
- Assume staff-level technical context unless told otherwise.

## Quality

- Inspect project config (`package.json`, etc.) for available scripts.
- Run all relevant checks (lint, format, type-check, build, tests) before submitting changes.
- Never claim checks passed unless they were actually run.
- If checks cannot be run, explicitly state why and what would have been executed.

## SCM

- Never use `git reset --hard` or force-push without explicit permission.
- Prefer safe alternatives (`git revert`, new commits, temp branches).
- If history rewrite seems necessary, explain and ask first.

## Production safety

- Assume production impact unless stated otherwise.
- Call out risk when touching auth, billing, data, APIs, or build systems.
- Prefer small, reversible changes; avoid silent breaking behavior.

## Self improvement

- Continuously improve agent workflows.
- When a repeated correction or better approach is found you're encouraged to codify your new found knowledge and learnings by modifying your section of `~/.codex/AGENTS.md`.
- You can modify `~/.codex/AGENTS.md` wuthout prior aproval as long as your edits stay under the `Agent instructions` section.
- If you utlise any of your codified instructions in future coding sessions call that out and let the user know that you peformed the action because of that specific rule in this file.

## Tool-specific memory

- Actively think beyond the immediate task.
- When using or working near a tool the user maintains:
  - If you notice patterns, friction, missing features, risks, or improvement opportunities, jot them down.
  - Do **not** interrupt the current task to implement speculative changes.
- Create or update a markdown file named after the tool in:
  - `~/Developer/AGENT/ideas` for new concepts or future directions
  - `~/Developer/AGENT/improvements` for enhancements to existing behavior
- These notes are informal, forward-looking, and may be partial.
- No permission is required to add or update files in these directories.

---
name: validate-changes-by-running
description: Validate changes by running lint first, then a timed smoke run of the project CLI with the right setup and flags.
---

# Validate Changes By Running

## Goal

Validate changes by running linting first, then running the project with a time limit that is long enough to catch startup and early runtime errors but not long enough to wait for full completion.

## Workflow

### 1) Discover the right commands (low-risk discovery only)

Look for existing project entry points and conventions before asking questions:
- `package.json` scripts (Node)
- `pyproject.toml`, `setup.cfg`, `tox.ini` (Python)
- `Cargo.toml` (Rust)
- `go.mod` (Go)
- `pom.xml` / `build.gradle` (Java)
- `Makefile`
- `README` and `docs/`

If multiple plausible commands exist and discovery does not resolve it, ask a single clarifying question (with options).

### 2) Run lint first

Run the project's linting command exactly as defined in the repo. If linting fails, stop and report the failure.

### 3) Run the project with a timeout (smoke run)

Run the most appropriate CLI command for the change (dev server, CLI entrypoint, worker, etc.) with a strict timeout.

Rules:
- Always apply a timeout to avoid waiting for full completion.
- Choose a timeout that catches startup and early runtime errors only (the user is responsible for any full-length run).
- Prefer flags that make a short run possible: `--help`, `--version`, `--dry-run`, `--once`, `--headless`, `--no-watch`, `--skip-setup`, `--port 0`.
- If the project starts a server, use a short startup window (typically 30-90 seconds) and consider adding a flag that exits after readiness or a single request if available.

### 4) Report results

Summarize:
- Lint command run and result
- Run command, timeout used, and result
- Any errors and where they occurred

## Timeout guidance

Use the shortest timeout that still provides signal:
- Simple CLI command: 10-30 seconds
- Dev server startup: 30-90 seconds
- Heavier components: 90-180 seconds

If the project is known to be slow, state why you picked a longer timeout and confirm it is still a smoke run.

## Tooling references (language agnostic)

### Timeout wrapper

- GNU coreutils: `timeout 30s <cmd>`
- macOS (if `timeout` is unavailable): `gtimeout 30s <cmd>` (from coreutils)

### Common lint and run commands (examples)

Node (npm/pnpm/yarn):
- Lint: `npm run lint` or `pnpm lint` or `yarn lint`
- Run: `timeout 60s npm run dev -- --host 127.0.0.1 --port 0`

Python:
- Lint: `python -m ruff check .` or `python -m flake8` or `python -m pylint <pkg>`
- Run: `timeout 30s python -m <module> --help`

Rust:
- Lint: `cargo clippy --all-targets --all-features` or `cargo fmt --check`
- Run: `timeout 30s cargo run -- --help`

Go:
- Lint: `golangci-lint run` or `go vet ./...`
- Run: `timeout 30s go run ./cmd/<app> --help`

Java:
- Lint: `mvn -q -DskipTests checkstyle:check` or `./gradlew check`
- Run: `timeout 60s mvn -q exec:java` or `timeout 60s ./gradlew run`

Ruby:
- Lint: `bundle exec rubocop`
- Run: `timeout 60s bundle exec rails server -p 0 -b 127.0.0.1`

Dotnet:
- Lint: `dotnet format --verify-no-changes`
- Run: `timeout 60s dotnet run --project <path> -- --help`

## When to ask a question

Ask only if discovery cannot determine:
- Which lint command is authoritative
- Which CLI should be used to run the project for the given change
- Required setup or environment variables

Keep questions short and provide options (with defaults) so the user can answer quickly.

---
name: ask-questions-if-underspecified
description: Clarify requirements before implementing. Do not use automatically, only when invoked explicitly.
---

# Ask Questions If Underspecified

## Goal

Ask the minimum set of clarifying questions needed to avoid wrong work; do not start implementing until the must-have questions are answered (or the user explicitly approves proceeding with stated assumptions).

## Workflow

### 1) Decide whether the request is underspecified

Treat a request as underspecified if after exploring how to perform the work, some or all of the following are not clear:
- Define the objective (what should change vs stay the same)
- Define "done" (acceptance criteria, examples, edge cases)
- Define scope (which files/components/users are in/out)
- Define constraints (compatibility, performance, style, deps, time)
- Identify environment (language/runtime versions, OS, build/test runner)
- Clarify safety/reversibility (data migration, rollout/rollback, risk)

If multiple plausible interpretations exist, assume it is underspecified.

### 2) Ask must-have questions first (keep it small)

Ask 1-5 questions in the first pass. Prefer questions that eliminate whole branches of work.

Make questions easy to answer:
- Optimize for scannability (short, numbered questions; avoid paragraphs)
- Offer multiple-choice options when possible
- Suggest reasonable defaults when appropriate (mark them clearly as the default/recommended choice; bold the recommended choice in the list, or if you present options in a code block, put a bold "Recommended" line immediately above the block and also tag defaults inside the block)
- Include a fast-path response (e.g., reply `defaults` to accept all recommended/default choices)
- Include a low-friction "not sure" option when helpful (e.g., "Not sure - use default")
- Separate "Need to know" from "Nice to know" if that reduces friction
- Structure options so the user can respond with compact decisions (e.g., `1b 2a 3c`); restate the chosen options in plain language to confirm

### 3) Pause before acting

Until must-have answers arrive:
- Do not run commands, edit files, or produce a detailed plan that depends on unknowns
- Do perform a clearly labeled, low-risk discovery step only if it does not commit you to a direction (e.g., inspect repo structure, read relevant config files)

If the user explicitly asks you to proceed without answers:
- State your assumptions as a short numbered list
- Ask for confirmation; proceed only after they confirm or correct them

### 4) Confirm interpretation, then proceed

Once you have answers, restate the requirements in 1-3 sentences (including key constraints and what success looks like), then start work.

## Question templates

- "Before I start, I need: (1) ..., (2) ..., (3) .... If you don't care about (2), I will assume ...."
- "Which of these should it be? A) ... B) ... C) ... (pick one)"
- "What would you consider 'done'? For example: ..."
- "Any constraints I must follow (versions, performance, style, deps)? If none, I will target the existing project defaults."
- Use numbered questions with lettered options and a clear reply format

```text
1) Scope?
a) Minimal change (default)
b) Refactor while touching the area
c) Not sure - use default
2) Compatibility target?
a) Current project defaults (default)
b) Also support older versions: <specify>
c) Not sure - use default

Reply with: defaults (or 1a 2a)
```

## Anti-patterns

- Don't ask questions you can answer with a quick, low-risk discovery read (e.g., configs, existing patterns, docs).
- Don't ask open-ended questions if a tight multiple-choice or yes/no would eliminate ambiguity faster.