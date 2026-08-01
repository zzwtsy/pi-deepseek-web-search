# AGENTS.md

pi-deepseek-web-search — a pi package that provides a DeepSeek-backed web search tool for pi sessions.

## Git and destructive operations

- **All git write operations require explicit user approval before execution**: commit, push, reset, revert, rebase, merge, branch/tag creation or deletion, and force operations.
- **Staging files (git add) also requires explicit approval**, unless the user has already asked to stage/commit a specific change.
- **Destructive file operations** (deleting files, moving/renaming tracked files, git clean, checkout overwriting worktree changes) likewise require explicit approval.
- Read-only operations (status, diff, log, show, grep) are always allowed.
- When a change is ready to be committed, present the summary and wait for explicit approval instead of committing.

## Coding conventions

- **Comments**: always in Chinese (code comments, JSDoc, docstrings).
- **Everything else**: English — identifiers (variables/functions/classes/filenames), UI text (tool label/description, command output, notifications/status strings), error messages, commit messages, code and commands inside docs.
- User-facing docs (README) may be written in Chinese, but code, identifiers, and commands within them stay English.

## Commands

- `pnpm check` — tsc --noEmit
- `pnpm lint` — eslint
- `pnpm test` — vitest
- `pnpm gen:schema` — regenerate the zh/en JSON Schemas from `src/config-schema.ts`
- `pi -e ./src/index.ts` — smoke-test the extension locally

## Architecture

- `src/index.ts` — extension entry point (default export factory), registers the `deepseek_web_search` tool (with `renderCall`/`renderResult`) and the `/deepseek-search` command. Composition point `createProvider()` wires config → provider; swapping the search backend changes this file only.
- `src/provider.ts` — search backend port: `SearchProvider` interface, `SearchError` taxonomy, price types, and provider-agnostic domain types. Adding a new backend = implement `SearchProvider` + wire it in `index.ts`; no other files change.
- `src/deepseek.ts` — DeepSeek `/responses` adapter implementing `SearchProvider` (web_search tool, server-side search).
- `src/config-schema.ts` — **single source of truth** for the config file definition (TypeBox): derives the `ConfigFileShape` type, the runtime validation, and the generated zh/en JSON Schemas.
- `src/config.ts` — config loading/merging (env var → project `.pi/` file → global file) and validation via the TypeBox schema.
- `src/format.ts` — pure functions: result assembly, truncation, cost computation (`computeCost`/`resolvePrices`).
- `src/cache.ts` — in-memory TTL cache.
- `src/render.ts` — TUI `renderCall`/`renderResult` (presentation only, no core logic).
- `tests/` — vitest unit tests with mocked fetch.

## Schema generation

- The config file definition lives **only** in `src/config-schema.ts` (TypeBox), with bilingual comments (`descriptionZh`/`descriptionEn`).
- After changing it, **always run `pnpm gen:schema`** — the generated `schema/*.json` files are committed, and a test asserts they stay in sync (a red test means the generation was skipped).
- Use `Type.Unsafe` for enums (e.g. `reasoningEffort`): `StringEnum` from pi-ai does not pass through custom keys like `descriptionZh`.
- `peak.hours` ordering (`start < end`) and empty `models` keys are validated at runtime in `config.ts` — JSON Schema cannot express them.

## Comments

- Three tiers (all comments in Chinese, per coding conventions):
  - `//` line comments — only "why": decisions, measured API findings, external constraints, gotchas.
  - `/** */` block comments — file headers (one-line responsibility) and exported symbols (interfaces, types, methods).
  - Never write: comments restating the code, commented-out code, changelog/history, decorative dividers.
- Contracts over tags: document when a function returns `undefined` or throws; use `@param`/`@returns` as needed, not on every function.
- Keep comments in sync with code: update adjacent comments when editing; stale comments must be fixed or removed. Avoid version numbers, dates, and "currently only supports X" phrasing — write the "why", not the "current state".

## Verification

- Before handing work back, run `pnpm check && pnpm lint && pnpm test` and report the result.

## Documentation map

- User docs: `README.md` (English, default) / `README.zh.md` (Chinese).
- Architecture decisions: `docs/design.md` (committed); working plans live in `docs/plans/` (gitignored).
