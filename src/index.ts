import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SearchConfig } from "./config.js";
import type { PriceConfig, SearchProvider, SearchResult, SearchUsage } from "./provider.js";
// 入口文件：注册 deepseek_web_search 工具。
// 依赖链：config（配置）→ provider（搜索后端端口）→ deepseek（DeepSeek 适配器）→ cache（TTL 缓存）→ format（结果组装）。
// 组合点 createProvider 是本扩展唯一的后端接入位置：换/加搜索后端只改这里。
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { TtlCache } from "./cache.js";
import { CONFIG_FILE_NAME, ConfigProvider, GLOBAL_CONFIG_DIR, validateConfig } from "./config.js";
import { DeepSeekClient } from "./deepseek.js";
import { buildToolContent, buildToolDetails, computeCost, normalizeQuery, resolvePrices } from "./format.js";
import { SearchError } from "./provider.js";
import { renderCall, renderResult } from "./render.js";
import { deepseekWebSearchSchema } from "./types.js";

export type { ConfigFileShape, SearchConfig } from "./config.js";
export type { SearchError, SearchErrorCode, SearchProvider, SearchResult, WebSearchAction } from "./provider.js";
export type { DeepSeekWebSearchDetails, DeepSeekWebSearchInput } from "./types.js";

/** 搜索缓存单例：模块级共享，reload 后随模块重置 */
let sharedCache: TtlCache<SearchResult> | undefined;

/** 配置提供者单例：进程内缓存随模块生命周期共享；cwd 变化时重建（同一项目内避免重复读文件） */
let configProvider: ConfigProvider | undefined;
let configProviderCwd: string | undefined;

function getConfigProvider(cwd: string): ConfigProvider {
  if (configProvider === undefined || configProviderCwd !== cwd) {
    configProvider = new ConfigProvider({ cwd });
    configProviderCwd = cwd;
  }
  return configProvider;
}

/** 组合点：把配置装配成 SearchProvider。换/加后端时只改这里（未来加 provider 配置字段后改为 switch + assertNever 分发） */
function createProvider(config: SearchConfig): SearchProvider {
  return new DeepSeekClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}

/** SearchUsage → pi 的 Usage（成本按价格配置实时计算，默认官方平峰价） */
function toPiUsage(usage: SearchUsage, prices: PriceConfig) {
  // DeepSeek 的 input_tokens 已包含 cached_tokens，而 pi 的 Usage 把 input/cacheRead 视为互斥并求和；
  // 未命中部分 = inputTokens - cachedTokens（与 computeCost 的 uncachedInput 一致），避免重复计数
  return {
    input: Math.max(usage.inputTokens - usage.cachedTokens, 0),
    output: usage.outputTokens,
    cacheRead: usage.cachedTokens,
    cacheWrite: 0,
    reasoning: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    cost: computeCost(usage, prices),
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "deepseek_web_search",
    label: "DeepSeek Web Search",
    description:
      "Search the web via the DeepSeek API. The search runs server-side and the response contains a synthesized answer with citations plus a record of the search actions. Use for up-to-date, time-sensitive, or external information.",
    promptSnippet: "Search the web via DeepSeek for up-to-date or external information",
    promptGuidelines: [
      "Use deepseek_web_search when the user asks about time-sensitive or external information that is not available in the local context.",
      "After a deepseek_web_search call, base your final answer on the returned content and cite the sources listed in it.",
    ],
    parameters: deepseekWebSearchSchema,
    renderCall,
    renderResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const startedAt = Date.now();
      // 先校验参数：缺失/空白 query 抛预期的校验错误，避免 normalizeQuery 对 undefined 抛裸 TypeError
      const query = typeof params.query === "string" ? normalizeQuery(params.query) : "";
      if (query === "") {
        throw new Error("Query must not be empty.");
      }
      const mode = params.mode ?? "answer";

      // 配置经单例进程内缓存读取（同一 cwd 下只读一次文件）
      const configProvider = getConfigProvider(ctx.cwd);
      const config = await configProvider.get();
      const configError = validateConfig(config);
      if (configError != null) {
        throw new Error(configError);
      }

      // 缓存 TTL 随配置变化重建单例；配置经 status reload 或重启刷新后，cacheTtlMs / DEEPSEEK_CACHE_TTL_MS 改动即可在下次搜索生效
      if (sharedCache === undefined || sharedCache.ttlMs !== config.cacheTtlMs) {
        sharedCache = new TtlCache<SearchResult>(config.cacheTtlMs);
      }
      const cache = sharedCache;

      // 缓存 key 显式隔离 cwd/baseUrl/model，避免不同项目或代理共用同一结果
      const cacheKey = JSON.stringify([ctx.cwd, config.baseUrl, config.model, mode, query]);
      const cachedResult = cache.get(cacheKey);
      if (cachedResult != null) {
        return {
          content: [
            {
              type: "text",
              text: buildToolContent(cachedResult, { mode, maxChars: config.maxResultChars }).content,
            },
          ],
          details: buildToolDetails(cachedResult, { query, mode, cached: true, durationMs: 0 }, config.maxResultChars),
          // 缓存命中不返回顶层 usage：本次工具执行没有真实 API 调用，返回首次 usage 会在 pi 会话统计中重复计费；
          // details.usage 仍保留首次搜索的原始记录，仅供展示
        };
      }

      const provider = createProvider(config);

      onUpdate?.({
        content: [{ type: "text", text: "Searching the web..." }],
        details: { stage: "searching" },
      });

      try {
        const result = await provider.search(query, {
          reasoningEffort: config.reasoningEffort,
          maxOutputTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
          signal,
        });

        onUpdate?.({
          content: [{ type: "text", text: "Synthesizing answer..." }],
          details: { stage: "answering" },
        });

        cache.set(cacheKey, result);
        const durationMs = Date.now() - startedAt;

        return {
          content: [
            {
              type: "text",
              text: buildToolContent(result, { mode, maxChars: config.maxResultChars }).content,
            },
          ],
          details: buildToolDetails(result, { query, mode, cached: false, durationMs }, config.maxResultChars),
          usage: result.usage ? toPiUsage(result.usage, resolvePrices(config.prices, config.model)) : undefined,
        };
      } catch (error) {
        if (error instanceof SearchError && error.code === "aborted") {
          // 用户取消：不标记为错误，返回说明文本
          return {
            content: [{ type: "text", text: "The web search was cancelled." }],
            details: { query, mode, cancelled: true },
          };
        }
        throw error;
      }
    },
  });

  // /deepseek-search 命令：查看配置状态 / 清空缓存。无 UI 模式（print/rpc）下仅依赖 notify，不调 dialog。
  pi.registerCommand("deepseek-search", {
    description: "Show config status or clear the search cache. Usage: /deepseek-search [status|clear-cache|config]",
    getArgumentCompletions: prefix =>
      ["status", "clear-cache", "config"]
        .filter(action => action.startsWith(prefix))
        .map(action => ({ value: action, label: action })),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";

      if (action === "clear-cache") {
        sharedCache?.clear();
        ctx.ui.notify("deepseek-search: cache cleared", "info");
        return;
      }
      if (action === "config") {
        const globalPath = join(homedir(), GLOBAL_CONFIG_DIR, CONFIG_FILE_NAME);
        // 持久可见输出：状态查看类信息不适合 notify（会淡出且截断），按官方最佳实践走 sendMessage(display: true)
        pi.sendMessage({
          customType: "deepseek-search",
          content: `Config files:\n  project: ${join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME)}\n  global: ${globalPath}`,
          display: true,
        });
        return;
      }
      if (action !== "status") {
        ctx.ui.notify(`Unknown action "${action}". Usage: /deepseek-search [status|clear-cache|config]`, "error");
        return;
      }

      // status 复用单例但强制 reload，反映用户最新改动（reload 是单例上唯一的刷新入口）
      const configProvider = getConfigProvider(ctx.cwd);
      const config = await configProvider.reload();
      const keyMasked = config.apiKey
        ? `${config.apiKey.slice(0, 3)}...${config.apiKey.slice(-4)}`
        : "not configured";
      const priceSummary = `${config.prices.inputPerMillion}/${config.prices.cachedInputPerMillion}/${config.prices.outputPerMillion}`
        + ` USD per 1M tokens (off-peak input miss/hit/output)${
          config.prices.peak != null ? ", peak pricing enabled" : ""}`;
      pi.sendMessage({
        customType: "deepseek-search",
        content: [
          `API key: ${keyMasked}`,
          `Model: ${config.model}`,
          `Base URL: ${config.baseUrl}`,
          `Reasoning effort: ${config.reasoningEffort}`,
          `Cache entries: ${sharedCache?.size() ?? 0}`,
          `Prices: ${priceSummary}`,
        ].join("\n"),
        display: true,
      });
    },
  });
}
