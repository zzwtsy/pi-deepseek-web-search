# pi-deepseek-web-search

[![npm version](https://img.shields.io/npm/v/pi-deepseek-web-search)](https://www.npmjs.com/package/pi-deepseek-web-search)
[![npm downloads](https://img.shields.io/npm/dw/pi-deepseek-web-search)](https://www.npmjs.com/package/pi-deepseek-web-search)
[![license](https://img.shields.io/npm/l/pi-deepseek-web-search)](LICENSE)

一个 [pi](https://github.com/earendil-works/pi) 扩展：为 pi 会话中的任意模型提供 **DeepSeek 联网搜索** 能力，桥接 DeepSeek `/responses` API 的服务端搜索。

[English](README.md)

## 功能特性

- **强制搜索**——每次调用都真实执行搜索（`tool_choice: { type: "web_search" }`），模型无法跳过
- **综合回答 + 引用**——由 DeepSeek 生成带引用的回答，同时返回执行的搜索动作记录
- **配置灵活**——环境变量 / 项目配置文件 / 全局配置文件（优先级从高到低）
- **TTL 结果缓存**——TTL 内相同查询直接命中缓存，零成本
- **真实成本上报**——token 单价可配置（美元/百万 tokens），默认启用官方峰谷定价；工具上报的 `Usage.cost` 为真实估算金额
- **模型可选**——`deepseek-v4-flash`（默认）与 `deepseek-v4-pro` 均支持 Responses API，改配置即切换
- **生成式 JSON Schema**——配置文件定义单一来源（`src/config-schema.ts`），中/英两份 Schema 由它自动生成（见 [Schema](#schema)）

## 安装

已通过 OIDC Trusted Publishing 发布到 npm（带 [SLSA provenance](https://slsa.dev) 证明）。在任意 pi 项目中：

```bash
pi install npm:pi-deepseek-web-search
```

然后在 pi 会话中执行 `/reload`。

本地开发本包时：`pi install .`，或将 `src/index.ts` 软链/复制到项目的 `.pi/extensions/`。

## 配置

配置按以下优先级读取（后者覆盖前者）：

1. 环境变量
2. 项目配置文件：`.pi/deepseek-web-search.json`
3. 全局配置文件：`~/.pi/agent/deepseek-web-search.json`

> 配置会在扩展进程内按工作目录缓存；修改配置文件或环境变量后，请重启 pi（或运行 `/deepseek-search status` 强制刷新）再继续搜索。

### 示例（`~/.pi/agent/deepseek-web-search.json`）

```jsonc
{
  "$schema": "./npm/node_modules/pi-deepseek-web-search/schema/deepseek-web-search.config.schema.zh.json",
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

> `$schema` 仅供编辑器自动补全/校验，运行时忽略。上述路径适用于包安装在项目 `node_modules`（相对 `.pi/` 目录）的场景；其他安装位置请自行调整。注释想要中文用 `.zh.json`，英文用 `.en.json`。

### 配置字段

| 字段 | 类型 | 默认值 | 说明 |
| ------ | ------ | -------- | ------ |
| `apiKey` | string | — | DeepSeek API key（必填）。`DEEPSEEK_API_KEY` 可覆盖 |
| `baseUrl` | string | `https://api.deepseek.com` | API 基础地址（自建代理时修改） |
| `model` | string | `deepseek-v4-flash` | 模型名。`DEEPSEEK_MODEL` 可覆盖 |
| `reasoningEffort` | `off`/`low`/`high`/`max` | `high` | `off` 关闭思考；`low`/`high`/`max` 控制思考量 |
| `maxOutputTokens` | int 1–384000 | `4096` | 回答最大输出 token 数（官方上限 384K） |
| `timeoutMs` | int ≥ 1 | `30000` | 单次请求超时（毫秒） |
| `cacheTtlMs` | int ≥ 1 | `300000` | 结果缓存 TTL（毫秒） |
| `maxResultChars` | int ≥ 1 | `50000` | 返回给模型的回答最大字符数 |
| `prices.inputPerMillion` | number > 0 | `0.22` | 输入单价，缓存未命中，空闲价（美元/百万 tokens） |
| `prices.cachedInputPerMillion` | number > 0 | `0.007` | 输入单价，缓存命中，空闲价（美元/百万 tokens） |
| `prices.outputPerMillion` | number > 0 | `0.66` | 输出单价，空闲价（美元/百万 tokens） |
| `prices.peak` | object | 官方高峰时段 | 峰谷定价覆盖（默认启用官方时段，见下） |
| `prices.models` | object | — | 按模型覆盖的价格表（key = 模型名） |

对应环境变量：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DEEPSEEK_REASONING_EFFORT`、`DEEPSEEK_MAX_OUTPUT_TOKENS`、`DEEPSEEK_TIMEOUT_MS`、`DEEPSEEK_CACHE_TTL_MS`、`DEEPSEEK_MAX_RESULT_CHARS`、`DEEPSEEK_PRICE_INPUT`、`DEEPSEEK_PRICE_CACHED_INPUT`、`DEEPSEEK_PRICE_OUTPUT`。

数字类环境变量只接受规范十进制字符串，例如 `30000` 或 `1.5`；`+1`、`.5`、`1e3`、`30_000`、`30s` 等形式会被拒绝。价格类环境变量按美元/百万 tokens 解释。

### 价格与峰谷

北京时间 2026-08-17 00:00 起，DeepSeek 采用峰谷计价。默认值遵循[官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：

| 模型 | 时段 | 输入（缓存未命中） | 输入（缓存命中） | 输出 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | 空闲 | $0.22 | $0.007 | $0.66 |
| `deepseek-v4-flash` | 高峰 | $0.44 | $0.014 | $1.32 |
| `deepseek-v4-pro` | 空闲 | $0.66 | $0.022 | $1.98 |
| `deepseek-v4-pro` | 高峰 | $1.32 | $0.044 | $3.96 |

单位均为美元/百万 tokens。高峰时段为**北京时间每日** 9:00–12:00 与 14:00–18:00，高峰价格 = 空闲价 × 2。官方峰谷时段默认启用；只有需要覆盖时才配置 `prices.peak`：

```jsonc
"prices": {
  "peak": {
    "multiplier": 2,
    "hours": [["09:00", "12:00"], ["14:00", "18:00"]]   // 半开区间 [start, end)
  }
}
```

- pro 的上述价格已预置在 `prices.models."deepseek-v4-pro"`，`model` 切换后自动生效
- 工具上报的 `Usage.cost` 为按配置单价估算的金额；缓存命中不产生成本（无真实调用），`details.usage` 仍保留首次搜索的原始用量记录供查看

### 模型支持

`deepseek-v4-flash` 与 `deepseek-v4-pro` 均支持 Responses API；两个别名当前分别指向 DeepSeek-V4-Flash-0731 与 DeepSeek-V4-Pro-0813，调用名不变。默认使用 `deepseek-v4-flash`；设置 `"model": "deepseek-v4-pro"`（或 `DEEPSEEK_MODEL`）即可切换——价格经 `prices.models` 自动联动。

## 使用

向模型提出时效性或外部信息问题，它会自动调用 `deepseek_web_search`：

> 今天北京的天气怎么样？

工具返回 DeepSeek 的综合回答（含引用）与搜索动作记录。结果按工作目录、baseUrl 与 `model:mode:query` 缓存 `cacheTtlMs`。

`/deepseek-search` 命令可查看配置状态（key 是否配置、模型、缓存条目数）并清空缓存。

## Schema

配置文件定义只在 `src/config-schema.ts`（TypeBox）维护**一次**，其余全部派生：

- `ConfigFileShape` 类型（`Static<>`）
- 运行时校验（`Check`/`Errors`）
- 两份生成式 JSON Schema：
  - `schema/deepseek-web-search.config.schema.en.json`（英文注释）
  - `schema/deepseek-web-search.config.schema.zh.json`（中文注释）

修改定义后重新生成：

```bash
pnpm gen:schema
```

生成文件随仓库提交，并有测试断言其与定义保持同步（防漂移）。

## 开发

```bash
pnpm check     # tsc --noEmit
pnpm lint      # eslint
pnpm test      # vitest
pnpm gen:schema
```

## FAQ

- **为什么不用内置的 web search 工具？** 当你希望搜索由 DeepSeek API 支撑（例如复用已有 DeepSeek 账号/余额，或会话模型没有内置搜索）时，本工具更有用。
- **会返回来源列表吗？** DeepSeek 搜索在服务端执行，回答内含行内引用；工具同时把执行的搜索动作（`searched:`/`opened:` 行）记录在返回内容中。
- **费用怎么算？** DeepSeek 按 token 计费；工具按你配置的单价估算并上报 `Usage.cost`。参见[官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。
- **报错 "API key is not configured"？** 设置 `DEEPSEEK_API_KEY` 或在配置文件中填 `apiKey`。
