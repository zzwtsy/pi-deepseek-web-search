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
- **Real cost reporting** — token prices are configurable (USD per 1M tokens), official peak/off-peak pricing is enabled by default, and the reported `Usage.cost` reflects the actual estimated spend
- **Model selectable** — `deepseek-v4-flash` (default) and `deepseek-v4-pro` both support the Responses API; switch models via config
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

> Config is cached in the extension process per working directory. After changing config files or environment variables, restart pi (or run `/deepseek-search status` to force a reload) before searching again. If no API key is configured here, the tool falls back to the DeepSeek provider API key already configured in pi.

### Example (`~/.pi/agent/deepseek-web-search.json`)

```jsonc
{
  "$schema": "./npm/node_modules/pi-deepseek-web-search/schema/deepseek-web-search.config.schema.en.json",
  "apiKey": "sk-...",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high",
  "prices": {
    "inputPerMillion": 0.22,
    "cachedInputPerMillion": 0.007,
    "outputPerMillion": 0.66
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
| `reasoningEffort` | `off`/`low`/`high`/`max` | `high` | `off` disables thinking; `low`/`high`/`max` control the amount |
| `maxOutputTokens` | int 1–384000 | `4096` | Max output tokens (official limit: 384K) |
| `timeoutMs` | int ≥ 1 | `30000` | Request timeout in ms |
| `cacheTtlMs` | int ≥ 1 | `300000` | Result cache TTL in ms |
| `maxResultChars` | int ≥ 1 | `50000` | Max chars of the answer returned to the model |
| `prices.inputPerMillion` | number > 0 | `0.22` | Input price, cache miss, off-peak (USD / 1M tokens) |
| `prices.cachedInputPerMillion` | number > 0 | `0.007` | Input price, cache hit, off-peak (USD / 1M tokens) |
| `prices.outputPerMillion` | number > 0 | `0.66` | Output price, off-peak (USD / 1M tokens) |
| `prices.peak` | object | official peak | Peak-hour pricing override (default follows the official weekday/weekend schedule, see below) |
| `prices.models` | object | — | Per-model price overrides keyed by model name |

Environment variable equivalents: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_REASONING_EFFORT`, `DEEPSEEK_MAX_OUTPUT_TOKENS`, `DEEPSEEK_TIMEOUT_MS`, `DEEPSEEK_CACHE_TTL_MS`, `DEEPSEEK_MAX_RESULT_CHARS`, `DEEPSEEK_PRICE_INPUT`, `DEEPSEEK_PRICE_CACHED_INPUT`, `DEEPSEEK_PRICE_OUTPUT`.

Numeric environment variables accept canonical decimal strings only, for example `30000` or `1.5`; forms such as `+1`, `.5`, `1e3`, `30_000`, and `30s` are rejected. Price environment variables are interpreted as USD per 1M tokens.

### Pricing and peak hours

From 2026-08-17 00:00 Beijing time, DeepSeek uses peak/off-peak pricing. Defaults follow the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing):

| Model | Period | Input (cache miss) | Input (cache hit) | Output |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | off-peak | $0.22 | $0.007 | $0.66 |
| `deepseek-v4-flash` | peak | $0.44 | $0.014 | $1.32 |
| `deepseek-v4-pro` | off-peak | $0.66 | $0.022 | $1.98 |
| `deepseek-v4-pro` | peak | $1.32 | $0.044 | $3.96 |

All values are USD per 1M tokens. On weekdays, peak hours are **Beijing time** 09:00–12:00 and 14:00–18:00, and peak price = off-peak × 2. From 2026-08-23 00:00 Beijing time, Saturday and Sunday are off-peak all day. The official schedule is enabled by default; set `prices.peak` only to override it:

```jsonc
"prices": {
  "peak": {
    "multiplier": 2,
    "hours": [["09:00", "12:00"], ["14:00", "18:00"]],   // half-open [start, end)
    "weekendOffPeak": true
  }
}
```

- The per-model pro prices above are preconfigured under `prices.models."deepseek-v4-pro"` and apply automatically when `model` is set to `deepseek-v4-pro`
- `weekendOffPeak` defaults to `true`; set it to `false` only when a custom price schedule should retain weekend peak pricing
- The `Usage.cost` reported by the tool reflects the computed estimate using the request start time; cached hits report no cost (no API call happened). `details.usage` still keeps the first search's raw usage record for inspection

### Model support

`deepseek-v4-flash` and `deepseek-v4-pro` both support the Responses API. The aliases currently point to DeepSeek-V4-Flash-0731 and DeepSeek-V4-Pro-0813; call names remain unchanged. `deepseek-v4-flash` is the default; set `"model": "deepseek-v4-pro"` (or `DEEPSEEK_MODEL`) to switch — prices switch automatically via `prices.models`.

## Usage

Ask the model a time-sensitive or external question; it will invoke `deepseek_web_search` automatically:

> What is the weather in Beijing today?

The tool returns DeepSeek's synthesized answer with citations plus the executed search actions. Results are cached per working directory, base URL, `model:mode:query` for `cacheTtlMs`.

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
