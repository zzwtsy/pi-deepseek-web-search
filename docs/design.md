# pi-deepseek-web-search 设计文档（Design Document）

> 状态：**已实现**（P0–P7 全部落地，94 个单测通过）。本文档是项目架构与设计决策的权威记录；修订代码时若设计与实现冲突，以本文档为准并同步更新。
>
> 相关文档：`AGENTS.md`（开发约定/命令/验证协议）、`README.md`（用户文档，中英双版）、`schema/*.json`（配置 Schema 生成产物，单一来源见 `src/config-schema.ts`）。

## 1. 设计目标与约束

**定位**：功能单一的 pi 扩展——一个工具（`deepseek_web_search`）桥接 DeepSeek `/responses` API 的服务端联网搜索。

**复杂度预算**：单工具扩展只配一个扩展点。分层、注册表、DI 容器等机制均为过度设计，明确不做（见 §8）。

**pi 生态约束**（决定架构形态的硬约束）：

| 约束 | 影响 |
| ------ | ------ |
| jiti 加载、无构建步骤 | 纯 TS + `erasableSyntaxOnly`；生成脚本用 Node 原生 TS |
| 注册必须同步（factory 内） | 组合点/闭包状态在工厂内完成 |
| `/reload` 整模块重载 | 模块级单例（缓存）即生命周期，**不需要**插件 lifecycle |
| 扩展错误 fail-open | 配置生成、命令、渲染均静默降级，不挂宿主 |
| 非 TUI 模式（print/json/rpc） | UI 方法有官方兜底：print 走 `noOpUIContext`，RPC 走协议输出；只选安全 API（见 §7） |

**调研依据**（2026-08，来源见 §10）：schema-first 是 2025 共识（TypeBox 为"JSON Schema 即交付物"首选）；JSON Schema 无官方 i18n，**每语言一份 schema 文件**是规范维护者偏好方案；命令输出按官方文档区分 notify（快速反馈）与 sendMessage（持久输出）。

## 2. 架构总览

### 2.1 文件地图（最终形态）

```text
src/
  index.ts          # 入口：注册工具（renderCall/renderResult）+ /deepseek-search 命令；组合点 createProvider
  provider.ts       # 搜索后端端口：SearchProvider、SearchError、价格类型、领域类型（纯类型，零 IO）
  deepseek.ts       # DeepSeek /responses 适配器：唯一知道厂商协议/HTTP 细节的文件
  config-schema.ts  # 配置定义单一来源（TypeBox）：派生类型、运行时校验、中/英两份 JSON Schema
  config.ts         # 配置加载/合并（env > 项目 .pi/ 文件 > 全局文件）+ 校验包装 + 例外校验
  format.ts         # 纯函数：结果组装、截断、成本计算（computeCost/resolvePrices）
  cache.ts          # 内存 TTL 缓存
  render.ts         # TUI renderCall/renderResult（纯展示）
scripts/
  generate-schema.ts  # pnpm gen:schema：单一来源 → 两份 schema 文件
schema/
  *.schema.zh.json / *.schema.en.json   # 生成产物（提交，测试防漂移）
```

### 2.2 依赖方向

```text
index.ts ──→ config.ts ──→ config-schema.ts（单一来源，被 config.ts 与生成脚本引用）
    │  └──→ provider.ts ←── deepseek.ts（适配器，implements SearchProvider）
    │  └──→ format.ts ──→ provider.ts（纯类型）
    └─────→ render.ts ──→ types.ts
                        └──→ format.ts（复用动作摘要格式化）
```

一条直线，无环：`provider.ts` 零 src 内 import；`deepseek.ts` 仅 `import type`（运行时擦除）。**组合点 `createProvider()` 是唯一知道具体实现的地方**。

## 3. 核心设计决策（ADR）

| # | 决策 | 理由 |
| --- | ------ | ------ |
| D1 | **强制搜索**：请求体固定 `tool_choice: { type: "web_search" }`，删除 `toolChoice` 配置项 | 插件职责即搜索，不让模型跳过；可配置 = 自废功能 |
| D2 | **`SearchProvider` 端口**（`search(query, options)`，消费者拥有） | Rule of Three：端口成本 ~10 行，机制（注册表/判别联合配置）等第二个后端真实落地再建 |
| D3 | **价格可配置 + 官方峰谷默认启用**：`prices` 空闲价基座 + 默认 `peak { multiplier: 2, hours }` | 官方峰谷已执行；空闲价 × 2 = 高峰价，三类计费项一致；默认跟随官方时段 |
| D4 | **峰谷按北京时间判定**（`Intl` 固定 `Asia/Shanghai`，不暴露配置） | 计费按北京时间；暴露时区只会配错。半开区间 `[start, end)` 消除边界歧义 |
| D5 | **模型可配置 + per-model 价格表**（`prices.models`）+ **缓存键含 cwd/baseUrl/model** | v4-flash 与 v4-pro 均支持 Responses API；`models` 整块覆盖（防幽灵配置）；缓存键隔离项目/代理/模型 |
| D6 | **配置单一来源**（TypeBox → `Static` 类型 + `Check`/`Errors` 校验 + 双语言 schema 生成） | 消除"手写 interface + 手写校验 + 手写 schema"三份漂移；生成产物提交 + 测试断言同步 |
| D7 | **错误模型**：`SearchError` 判别联合（`code`），接口层只认领域错误 | 厂商错误类（`DeepSeekError`）不泄漏到接口层；`aborted` 特殊处理（返回取消说明，不标 isError） |
| D8 | **命令输出**：状态查看走 `sendMessage(display: true)`（持久可见），快速反馈走 `notify` | 官方最佳实践：notify 会淡出且截断，不适合多行状态 |
| D9 | **渲染纯函数** + 本地结构化类型（不依赖 `pi-agent-core`） | 只被 TUI 调用、无终端副作用；`pi-agent-core` 非直接依赖（pnpm 解析不到），用参数逆变兼容注册签名 |
| D10 | **`Type.Unsafe` 替代 `StringEnum`** 定义枚举字段 | 实测 `StringEnum` 不透传自定义注释键（`descriptionZh`） |

## 4. 扩展点：新增搜索后端

端口已就绪，成本 O(1)：

1. 新增 `src/<backend>.ts`：实现 `SearchProvider`（如 Anthropic 路线转 `web_search_tool_result`）
2. `config.ts` 加 `provider` 配置字段（默认 `"deepseek-responses"`），`createProvider` 改 `switch + assertNever` 穷尽分发
3. 完成。缓存、格式化、schema、命令、渲染**零改动**（缓存键含 model 已兼容多后端）

端口形状若在落地第二后端时发现不合适，改 `SearchProvider` 是 5 行的事——机制等第三个实例，端口现在就留。

## 5. 配置与 Schema（单一来源）

### 5.1 配置层级

`环境变量 > 项目 .pi/deepseek-web-search.json > 全局 ~/.pi/agent/deepseek-web-search.json > 默认值`，字段级 merge（`prices` 嵌套对象做一层深合并，防止 `Object.assign` 整块覆盖）。

配置在扩展进程内按 cwd 缓存（`ConfigProvider` 单例）；修改配置文件或环境变量后需重启 pi / `/reload`，或运行 `/deepseek-search status` 强制刷新。

字段全集与约束见生成的 schema 文件（编辑器可经 `$schema` 引用获得补全/校验）：

- `schema/deepseek-web-search.config.schema.en.json`（英文注释）
- `schema/deepseek-web-search.config.schema.zh.json`（中文注释）

### 5.2 单一来源流程

```text
src/config-schema.ts（TypeBox 定义：约束 + descriptionZh/descriptionEn）
        │  Static<typeof>  → ConfigFileShape 类型
        │  Check/Errors    → 运行时校验（config.ts）
        └─ pnpm gen:schema → 两份 JSON Schema（生成产物）
```

- 改定义后**必须** `pnpm gen:schema`；测试断言生成物与提交文件一致（防漂移，红 = 漏跑）
- **校验例外**（JSON Schema 表达力之外，保留在 `config.ts`）：`peak.hours` 的 `start < end`、`models` 空 key
- `$schema` 字段仅编辑器使用，运行时剥离

## 6. 成本计算

```text
cost.input     = max(input - cached, 0) / 1e6 × inputPerMillion × peakMultiplier
cost.cacheRead = cached / 1e6 × cachedInputPerMillion × peakMultiplier
cost.output    = output / 1e6 × outputPerMillion × peakMultiplier
peakMultiplier = 命中北京高峰时段（每日 9:00-12:00 / 14:00-18:00，半开）? peak.multiplier : 1
```

- 默认价 = 官方空闲价（deepseek-v4-flash：1.5 / 0.05 / 4.5 元/百万 tokens）；`prices.models` 按当前 `model` 覆盖（`resolvePrices`，缺省回退顶层，pro 预置 4.5 / 0.15 / 13.5）
- 官方 peak 默认启用（multiplier=2，北京时间每日 9:00-12:00 / 14:00-18:00）；工具 TTL 缓存命中路径**不报 cost**（无真实 API 调用，如实显示零成本）
- reasoning tokens 计入输出计费（官方按输出总 token 计费）

## 7. 非 TUI 兼容性

| 模式 | `ctx.ui.notify`（命令反馈） | `sendMessage(display)`（命令状态输出） | renderCall/renderResult | onUpdate |
| ------ | --------------------------- | -------------------------------------- | ------------------------ | ---------- |
| interactive | 显示通知 | 会话记录持久可见 | 正常调用 | 阶段进度 |
| rpc | fire-and-forget 协议输出 | 消息输出给客户端 | 不调用（无渲染管线） | 可选调用 |
| print/json | no-op（`noOpUIContext`） | 写会话记录 | 不调用 | 可选调用 |

设计规则：**只用官方保证安全的 API**（notify/sendMessage 无需 `hasUI` 守卫；dialog 方法一律不用；TUI-only 的 `custom()`/组件工厂不用），因此不存在模式崩溃面。渲染函数是纯函数（构建 Component 数据结构，不碰终端）。

## 8. 明确不做（防过度设计）

| 不做 | 原因 |
| ------ | ------ |
| use case 层 / ports 目录 / adapter 目录 | execute 约 50 行，分层收益 < 跳转成本 |
| provider 注册表 / 判别联合配置 / fallback 链 | Rule of Three：第二个后端落地时再建（§4） |
| 动态 `import()` 插件加载 / plugin lifecycle | pi 的 `/reload` + 模块单例就是生命周期 |
| DI 容器 | 手工组合 3 行；`erasableSyntaxOnly` 下判别联合是唯一正道 |
| 多轮追问（open_page 续搜）/ Anthropic 格式路线 / overlay 浏览 | 官方不暴露结构化搜索结果，价值低；Anthropic 路线是潜在替代后端，见 §4 |
| 峰谷双价自动切换之外的高级计费（节假日/分模型倍率） | 官方规则就是"统一翻倍"，够用 |

## 9. 测试策略

| 层 | 覆盖 | 依赖 |
| ---- | ------ | ------ |
| 纯函数（format/config-schema） | 截断、组装、`computeCost`/`isPeakTime`/`resolvePrices`、schema 一致性、default 对齐 | 无 |
| 适配器（deepseek） | 请求构造（含强制 tool_choice）、响应解析、错误映射、重试/超时/取消 | mock fetch |
| 配置（config） | 优先级合并、TypeBox 校验等价性（18 条非法输入固化）、`$schema` 剥离、双语言 schema 防漂移 | 注入 env/readFile |
| 端到端 | 真实 key 冒烟 + `pi install ./` + `/reload` | 人工（需 API key） |

## 10. 参考来源

### Clean / Hexagonal Architecture（TypeScript）

- [Clean Architecture in Frontend: A How-To Guide — Feature-Sliced Design](https://feature-sliced.design/blog/frontend-clean-architecture)
- [Best Practices and Patterns — bespoyasov/frontend-clean-architecture (DeepWiki)](https://deepwiki.com/bespoyasov/frontend-clean-architecture/8-best-practices-and-patterns)
- [brocoders/nestjs-boilerplate — Hexagonal architecture docs](https://github.com/brocoders/nestjs-boilerplate/blob/1d4db0b8/docs/architecture.md?plain=1#L30-L60)
- [AmiirRahimi/architecture-patterns-collection（10 种 TS 架构模式）](https://github.com/AmiirRahimi/architecture-patterns-collection)

### 插件 / provider 架构

- [Fowler — Inversion of Control / Plugin 模式基础](https://martinfowler.com/articles/injection.html)
- [The Strategy Pattern in TypeScript: Discriminated Unions Beat Subclasses](https://dev.to/gabrielanhaia/the-strategy-pattern-in-typescript-discriminated-unions-beat-subclasses-17na)
- [llm-ports — TypeScript 多 provider LLM 抽象层](https://github.com/baabakk/llm-ports)
- [wha.ts — 插件系统设计（HostAPI 最小化）](https://github.com/jlucaso1/wha.ts/issues/5)

### pi 扩展开发

- [pi 官方文档 — extensions.md（earendil-works/pi）](https://github.com/earendil-works/pi/blob/v0.78.1/packages/coding-agent/docs/extensions.md)
- [pi — Custom Tools & Event Hooks (DeepWiki)](https://deepwiki.com/badlogic/pi-mono/4.4.2-custom-tools-and-event-hooks)
- [pi — RPC 模式扩展 UI 协议（rpc.md）](https://github.com/earendil-works/pi/blob/v0.78.1/packages/coding-agent/docs/rpc.md)
- [Slash Commands 教程（命令输出最佳实践）](https://github.com/az9713/pi-vs-claude-code/blob/main/docs/tutorials/03-slash-commands.md)
- [oh-my-pi — 扩展编写指南](https://github.com/can1357/oh-my-pi/blob/dc6446c1/docs/extensions.md)

### 配置单一来源与 Schema 多语言

- [TypeBox vs Zod — Better Stack](https://betterstack.com/community/guides/scaling-nodejs/typebox-vs-zod/)
- [TSDoc 规范（tsdoc.org）](https://tsdoc.org/pages/intro/approach/)
- [JSON Schema i18n 讨论 — json-schema-spec#53](https://github.com/json-schema-org/json-schema-spec/issues/53)
- [JSON Schema Localization wiki](https://github.com/json-schema-org/json-schema-spec/wiki/Localization)
- [AGENTS.md 最佳实践 — Layer5](https://layer5.io/blog/ai/agentsmd-one-file-to-guide-them-all)
