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
  return {
    input: usage.inputTokens,
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
      const query = normalizeQuery(params.query);
      if (query === "") {
        throw new Error("Query must not be empty.");
      }
      const mode = params.mode ?? "answer";

      // 每次执行读取配置（ConfigProvider 内部有进程内缓存，读取开销小）
      const configProvider = new ConfigProvider({ cwd: ctx.cwd });
      const config = await configProvider.get();
      const configError = validateConfig(config);
      if (configError != null) {
        throw new Error(configError);
      }

      // 首个使用点按配置的 TTL 创建缓存单例
      sharedCache ??= new TtlCache<SearchResult>(config.cacheTtlMs);
      const cache = sharedCache;

      const cacheKey = `${config.model}:${mode}:${query}`;
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

      const configProvider = new ConfigProvider({ cwd: ctx.cwd });
      const config = await configProvider.get();
      const keyMasked = config.apiKey
        ? `${config.apiKey.slice(0, 3)}...${config.apiKey.slice(-4)}`
        : "not configured";
      const priceSummary = `${config.prices.inputPerMillion}/${config.prices.cachedInputPerMillion}/${config.prices.outputPerMillion}`
        + ` CNY per 1M tokens (input miss/hit/output)${
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
