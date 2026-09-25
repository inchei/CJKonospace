# AGENTS.md

CJKonospace — CJK × monospace blending workbench (Vite + React 19 + TS + Tailwind v4).
License: GPL-3.0-only (see LICENSE).

## Commands

```bash
pnpm install          # install deps
pnpm dev              # dev server
pnpm build            # production build (dist/)

pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint (TS/React)
pnpm lint:fix         # ESLint auto-fix
pnpm lint:css         # Stylelint (CSS)
pnpm lint:css:fix     # Stylelint auto-fix
pnpm format           # Prettier + Ruff format
pnpm format:check     # Prettier check
pnpm knip             # unused exports/files
pnpm lint:py          # Ruff lint (scripts/, wasm/)
pnpm lint:py:fix      # Ruff lint --fix
pnpm format:py        # Ruff format
pnpm format:py:check  # Ruff format --check
pnpm quality:py       # Ruff lint + format check
pnpm quality          # typecheck + lint + lint:css + format:check + knip + quality:py
```

Python tooling is Ruff via `uvx` (pinned in package.json); install [uv](https://docs.astral.sh/uv/) — no `pip install` needed. Config lives in `pyproject.toml`.

Pre-commit hook (`.husky/pre-commit`) runs lint-staged (ESLint + Stylelint + Prettier + Ruff on staged files) plus `tsc --noEmit`. Quality is enforced here, not in CI.
Setup after clone: `git config core.hooksPath .husky`.
CI (`.github/workflows/pages.yml`) only builds and deploys GitHub Pages.

## Conventions

- pnpm only (never npm/yarn).
- Conventional commits, one-line English title: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`.
- NEVER commit unless the user explicitly asks.
- Long-running command output goes to files under `/tmp/opencode/`; read/search the file instead of piping through `head`/`tail`/`grep` for re-runs.
- Edit code files with the Edit tool only; Python/shell scripts may read/analyze output but must never write code files.
- All code comments in English. i18n UI strings stay in their own languages (`src/lib/i18n.ts`).
- No browser smoke tests or screenshots unless the user asks.
