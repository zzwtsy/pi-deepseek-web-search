# pi-deepseek-web-search

[![npm version](https://img.shields.io/npm/v/pi-deepseek-web-search)](https://www.npmjs.com/package/pi-deepseek-web-search)
[![npm downloads](https://img.shields.io/npm/dw/pi-deepseek-web-search)](https://www.npmjs.com/package/pi-deepseek-web-search)
[![license](https://img.shields.io/npm/l/pi-deepseek-web-search)](LICENSE)

A [pi](https://github.com/earendil-works/pi) extension that gives any model in your pi sessions a **DeepSeek-backed web search** tool, bridging the DeepSeek `/responses` API server-side web search.

[中文说明](README.zh.md)

## Features

- **Forced search** — every call executes a real web search (`tool_choice: { type: "web_search" }`); the model cannot skip it
- **Synthesized answer with citations** returned by DeepSeek, plus a record of the executed search actions
- **Configurable** via env vars, project config file, or global config file (in that order of precedence)
- **TTL result cache** — repeated identical queries within the TTL hit the cache and cost nothing
- **Real cost reporting** — token prices are configurable (CNY per million tokens) with future peak-hour pricing support, and the reported `Usage.cost` reflects the actual estimated spend
- **Model selectable** — `deepseek-v4-flash` (default) now; switch to `deepseek-v4-pro` by config once it supports the Responses API
- **Generated JSON Schema** — the config file definition is a single source of truth (`src/config-schema.ts`); English and Chinese schemas are generated from it (see [Schema](#schema))

## Install

Published to npm with [SLSA provenance](https://slsa.dev) via OIDC Trusted Publishing. In any pi project:

```bash
pi install npm:pi-deepseek-web-search
```

Then run `/reload` in the pi session.

Alternatively, for local development of this package: `pi install .`, or symlink/copy `src/index.ts` into your project's `.pi/extensions/`.

## Configuration

Config is read from, in order of precedence (later sources override earlier ones):

1. Environment variables
2. Project config file: `.pi/deepseek-web-search.json`
3. Global config file: `~/.pi/agent/deepseek-web-search.json`

### Example (`.pi/deepseek-web-search.json`)

```jsonc
{
  "$schema": "../node_modules/pi-deepseek-web-search/schema/deepseek-web-search.config.schema.en.json",
  "apiKey": "sk-...",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "low",
  "prices": {
    "inputPerMillion": 1,
    "cachedInputPerMillion": 0.02,
    "outputPerMillion": 2
  }
}
```

> `$schema` is only used by editors for autocomplete/validation and is ignored at runtime. The path above works when the package is installed in the project's `node_modules` (relative to `.pi/`); adjust it for other install locations. Use the `.en.json` schema for English comments, or the `.zh.json` one for Chinese.

### Config fields

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `apiKey` | string | — | DeepSeek API key (required). `DEEPSEEK_API_KEY` overrides |
| `baseUrl` | string | `https://api.deepseek.com` | API base URL (change when using a proxy) |
| `model` | string | `deepseek-v4-flash` | Model name. `DEEPSEEK_MODEL` overrides |
| `reasoningEffort` | `off`/`low`/`high`/`auto` | `low` | `off` disables thinking to save tokens |
| `maxOutputTokens` | int ≥ 1 | `4096` | Max output tokens |
| `timeoutMs` | int ≥ 1 | `30000` | Request timeout in ms |
| `cacheTtlMs` | int ≥ 1 | `300000` | Result cache TTL in ms |
| `maxResultChars` | int ≥ 1 | `50000` | Max chars of the answer returned to the model |
| `prices.inputPerMillion` | number > 0 | `1` | Input price, cache miss (CNY / 1M tokens) |
| `prices.cachedInputPerMillion` | number > 0 | `0.02` | Input price, cache hit |
| `prices.outputPerMillion` | number > 0 | `2` | Output price |
| `prices.peak` | object | — | Peak-hour pricing override (optional, see below) |
| `prices.models` | object | — | Per-model price overrides keyed by model name |

Environment variable equivalents: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_REASONING_EFFORT`, `DEEPSEEK_MAX_OUTPUT_TOKENS`, `DEEPSEEK_TIMEOUT_MS`, `DEEPSEEK_CACHE_TTL_MS`, `DEEPSEEK_MAX_RESULT_CHARS`, `DEEPSEEK_PRICE_INPUT`, `DEEPSEEK_PRICE_CACHED_INPUT`, `DEEPSEEK_PRICE_OUTPUT`.

### Pricing and peak hours

Default prices follow the [official DeepSeek pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) (deepseek-v4-flash: 1 / 0.02 / 2 CNY per million tokens). Pricing is configurable, and a peak-hour override is already supported:

```jsonc
"prices": {
  "peak": {
    "multiplier": 2,
    "hours": [["09:00", "12:00"], ["14:00", "18:00"]]   // half-open [start, end)
  }
}
```

- Peak hours follow the official definition: **daily, Beijing time** 09:00–12:00 and 14:00–18:00 (the pricing scheme is *pending* official rollout — omit `peak` until then)
- Peak price = base × `multiplier`, applied to all billing items
- Per-model overrides: `prices.models."deepseek-v4-pro" = { "inputPerMillion": 3, "cachedInputPerMillion": 0.025, "outputPerMillion": 6 }` — used automatically when `model` is set to that model
- The `Usage.cost` reported by the tool reflects the computed estimate; cached hits report no cost (no API call happened)

### Model support

The Responses API currently supports only `deepseek-v4-flash`; `deepseek-v4-pro` support is expected in early August 2026. Set `"model": "deepseek-v4-pro"` (or `DEEPSEEK_MODEL`) once it is available — prices switch automatically via `prices.models`.

## Usage

Ask the model a time-sensitive or external question; it will invoke `deepseek_web_search` automatically:

> What is the weather in Beijing today?

The tool returns DeepSeek's synthesized answer with citations plus the executed search actions. Results are cached per `model:mode:query` for `cacheTtlMs`.

The `/deepseek-search` command shows config status (key configured, model, cache size) and can clear the cache.

## Schema

The config file definition is maintained **once** in `src/config-schema.ts` (TypeBox) and everything else is derived:

- `ConfigFileShape` type (via `Static<>`)
- Runtime validation (via `Check`/`Errors`)
- Two generated JSON Schema files:
  - `schema/deepseek-web-search.config.schema.en.json` (English comments)
  - `schema/deepseek-web-search.config.schema.zh.json` (Chinese comments)

Regenerate after changing the definition:

```bash
pnpm gen:schema
```

Generated files are committed and a test asserts they stay in sync with the definition.

## Development

```bash
pnpm check     # tsc --noEmit
pnpm lint      # eslint
pnpm test      # vitest
pnpm gen:schema
```

## FAQ

- **Why not the built-in web search tool?** This tool is useful when you want search backed by the DeepSeek API (e.g., to reuse an existing DeepSeek account/balance, or when the session model lacks a built-in search).
- **Does it return a list of sources?** DeepSeek's search runs server-side; the answer contains inline citations, and the tool additionally records the executed search actions (`searched:`/`opened:` lines) in the returned content.
- **How much does it cost?** DeepSeek charges per token; the tool reports an estimated `Usage.cost` based on your configured prices. See the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing).
- **I get an "API key is not configured" error** — set `DEEPSEEK_API_KEY` or add `apiKey` to the config file.
