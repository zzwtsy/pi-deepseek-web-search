# pi-deepseek-web-search

一个 [pi](https://github.com/earendil-works/pi) 扩展：为 pi 会话中的任意模型提供 **DeepSeek 联网搜索** 能力，桥接 DeepSeek `/responses` API 的服务端搜索。

[English](README.md)

## 功能特性

- **强制搜索**——每次调用都真实执行搜索（`tool_choice: { type: "web_search" }`），模型无法跳过
- **综合回答 + 引用**——由 DeepSeek 生成带引用的回答，同时返回执行的搜索动作记录
- **配置灵活**——环境变量 / 项目配置文件 / 全局配置文件（优先级从高到低）
- **TTL 结果缓存**——TTL 内相同查询直接命中缓存，零成本
- **真实成本上报**——token 单价可配置（元/百万 tokens），并前瞻支持峰谷定价；工具上报的 `Usage.cost` 为真实估算金额
- **模型可选**——默认 `deepseek-v4-flash`；`deepseek-v4-pro` 适配 Responses API 后改配置即切换
- **生成式 JSON Schema**——配置文件定义单一来源（`src/config-schema.ts`），中/英两份 Schema 由它自动生成（见 [Schema](#schema)）

## 安装

在包根目录：

```bash
pi install .
```

或将 `src/index.ts` 软链/复制到项目的 `.pi/extensions/`，在 pi 会话中执行 `/reload`。

## 配置

配置按以下优先级读取（后者覆盖前者）：

1. 环境变量
2. 项目配置文件：`.pi/deepseek-web-search.json`
3. 全局配置文件：`~/.pi/agent/deepseek-web-search.json`

### 示例（`.pi/deepseek-web-search.json`）

```jsonc
{
  "$schema": "../schema/deepseek-web-search.config.schema.zh.json",
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

> `$schema` 仅供编辑器自动补全/校验，运行时忽略。注释想要中文用 `.zh.json`，英文用 `.en.json`。

### 配置字段

| 字段 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| `apiKey` | string | — | DeepSeek API key（必填）。`DEEPSEEK_API_KEY` 可覆盖 |
| `baseUrl` | string | `https://api.deepseek.com` | API 基础地址（自建代理时修改） |
| `model` | string | `deepseek-v4-flash` | 模型名。`DEEPSEEK_MODEL` 可覆盖 |
| `reasoningEffort` | `off`/`low`/`high`/`auto` | `low` | `off` 关闭思考以省 token |
| `maxOutputTokens` | int ≥ 1 | `4096` | 回答最大输出 token 数 |
| `timeoutMs` | int ≥ 1 | `30000` | 单次请求超时（毫秒） |
| `cacheTtlMs` | int ≥ 1 | `300000` | 结果缓存 TTL（毫秒） |
| `maxResultChars` | int ≥ 1 | `50000` | 返回给模型的回答最大字符数 |
| `prices.inputPerMillion` | number > 0 | `1` | 输入单价（缓存未命中，元/百万 tokens） |
| `prices.cachedInputPerMillion` | number > 0 | `0.02` | 输入单价（缓存命中） |
| `prices.outputPerMillion` | number > 0 | `2` | 输出单价 |
| `prices.peak` | object | — | 峰谷定价覆盖（可选，见下） |
| `prices.models` | object | — | 按模型覆盖的价格表（key = 模型名） |

对应环境变量：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DEEPSEEK_REASONING_EFFORT`、`DEEPSEEK_MAX_OUTPUT_TOKENS`、`DEEPSEEK_TIMEOUT_MS`、`DEEPSEEK_CACHE_TTL_MS`、`DEEPSEEK_MAX_RESULT_CHARS`、`DEEPSEEK_PRICE_INPUT`、`DEEPSEEK_PRICE_CACHED_INPUT`、`DEEPSEEK_PRICE_OUTPUT`。

### 价格与峰谷

默认价格遵循[官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（deepseek-v4-flash：1 / 0.02 / 2 元/百万 tokens）。价格可配置，峰谷覆盖已就绪：

```jsonc
"prices": {
  "peak": {
    "multiplier": 2,
    "hours": [["09:00", "12:00"], ["14:00", "18:00"]]   // 半开区间 [start, end)
  }
}
```

- 高峰时段按官方定义：**北京时间每日** 9:00–12:00 与 14:00–18:00（官方"即将执行"，正式通知前无需配置 `peak`）
- 高峰价格 = 平峰 × `multiplier`，适用所有计费项
- 按模型覆盖：`prices.models."deepseek-v4-pro" = { "inputPerMillion": 3, "cachedInputPerMillion": 0.025, "outputPerMillion": 6 }`——`model` 切换后自动生效
- 工具上报的 `Usage.cost` 为按配置单价估算的金额；缓存命中不产生成本（无真实调用）

### 模型支持

Responses API 目前仅支持 `deepseek-v4-flash`；`deepseek-v4-pro` 预计 2026 年 8 月初支持。适配后设置 `"model": "deepseek-v4-pro"`（或 `DEEPSEEK_MODEL`）即可切换——价格经 `prices.models` 自动联动。

## 使用

向模型提出时效性或外部信息问题，它会自动调用 `deepseek_web_search`：

> 今天北京的天气怎么样？

工具返回 DeepSeek 的综合回答（含引用）与搜索动作记录。结果按 `model:mode:query` 缓存 `cacheTtlMs`。

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
