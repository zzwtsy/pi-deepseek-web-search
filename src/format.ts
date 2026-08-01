// 结果格式化：组装给 LLM 的 content 与渲染用的 details，包含截断逻辑。
// 纯函数，便于单元测试。UI 文本一律英文。
import type { PriceConfig, SearchResult, SearchUsage, WebSearchAction } from "./provider.js";

export interface ToolContentOptions {
  mode: "answer" | "results";
  maxChars: number;
}

export interface ToolDetails {
  query: string;
  mode: "answer" | "results";
  searches: WebSearchAction[];
  answer: string;
  truncated: boolean;
  cached: boolean;
  durationMs: number;
  model: string;
  /** 本次搜索的 token 用量（缓存命中时沿用首次搜索的记录） */
  usage?: SearchUsage;
}

/** 按字符截断文本，超出时在末尾追加截断标记 */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars)
    return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n...[truncated]`, truncated: true };
}

/** 搜索动作的展示摘要（过滤掉无意义的空查询） */
function formatActions(actions: WebSearchAction[]): string[] {
  const lines: string[] = [];
  for (const action of actions) {
    if (action.type === "search" && action.queries != null && action.queries.length > 0) {
      lines.push(`- searched: ${action.queries.join(" | ")}`);
    } else if ((action.type === "open_page" || action.type === "find_in_page") && action.url != null) {
      lines.push(`- ${action.type === "open_page" ? "opened" : "searched in"}: ${action.url}`);
    }
  }
  return lines;
}

/**
 * 组装返回给 LLM 的 content 文本。
 * answer 模式：完整回答 + 搜索动作记录；results 模式：仅压缩后的回答摘要。
 */
export function buildToolContent(result: SearchResult, options: ToolContentOptions): {
  content: string;
  truncated: boolean;
} {
  if (result.answer.trim() === "") {
    return {
      content: `The search returned no usable answer. The search actions executed:${
        result.actions.length > 0 ? `\n${formatActions(result.actions).join("\n")}` : " none"}`,
      truncated: false,
    };
  }

  if (options.mode === "results") {
    const { text, truncated } = truncate(result.answer, options.maxChars);
    return { content: text, truncated };
  }

  const { text, truncated } = truncate(result.answer, options.maxChars);
  const actionLines = formatActions(result.actions);
  const content = actionLines.length > 0
    ? `${text}\n\nSearch actions:\n${actionLines.join("\n")}`
    : text;
  return { content, truncated };
}

/** 组装 details（供 TUI 渲染层使用；answer 与 content 同源，均为截断后文本） */
export function buildToolDetails(
  result: SearchResult,
  options: { query: string; mode: "answer" | "results"; cached: boolean; durationMs: number },
  maxChars: number,
): ToolDetails {
  const { text, truncated } = truncate(result.answer, maxChars);
  return {
    query: options.query,
    mode: options.mode,
    searches: result.actions,
    answer: text,
    truncated,
    cached: options.cached,
    durationMs: options.durationMs,
    model: result.model,
    usage: result.usage,
  };
}

/** 成本明细（元）：input/output/cacheRead 之和为 total */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * 判断 now 是否处于高峰时段（北京时间每日；与机器时区无关，官方按北京时间计费）。
 * 半开区间 [start, end)：09:00 计高峰、12:00 不计，两个时段无缝衔接。
 */
export function isPeakTime(now: Date, hours: Array<[string, string]>): boolean {
  // Intl 输出如 "09:30"（en-US hour12:false 可能有前导空格或 "24:00" 表示午夜），归一化为 HH:MM
  let hhmm = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  hhmm = hhmm.replace(/\s+/g, "").padStart(5, "0");
  if (hhmm === "24:00")
    hhmm = "00:00";
  return hours.some(([start, end]) => hhmm >= start && hhmm < end);
}

/**
 * 取当前模型生效的价格：models 表命中则返回"顶层为底 + 覆盖价叠加"的结果，否则返回顶层。
 * 返回不含 models 字段（已解析），可直接传给 computeCost。
 */
export function resolvePrices(prices: PriceConfig, model: string): PriceConfig {
  const override = prices.models?.[model];
  if (override == null)
    return prices;
  return {
    inputPerMillion: override.inputPerMillion ?? prices.inputPerMillion,
    cachedInputPerMillion: override.cachedInputPerMillion ?? prices.cachedInputPerMillion,
    outputPerMillion: override.outputPerMillion ?? prices.outputPerMillion,
    peak: override.peak ?? prices.peak,
  };
}

/**
 * 按价格配置计算成本（元）。
 * cachedTokens 是 inputTokens 的子集：未命中部分 = input - cached，命中部分按缓存单价。
 * 配置了 peak 且 now 处于高峰时段时，所有单价 × multiplier。
 */
export function computeCost(usage: SearchUsage, prices: PriceConfig, now: Date = new Date()): CostBreakdown {
  const peakMultiplier
    = prices.peak != null && isPeakTime(now, prices.peak.hours) ? prices.peak.multiplier : 1;
  const uncachedInput = Math.max(usage.inputTokens - usage.cachedTokens, 0);
  const input = (uncachedInput / 1_000_000) * prices.inputPerMillion * peakMultiplier;
  const cacheRead = (usage.cachedTokens / 1_000_000) * prices.cachedInputPerMillion * peakMultiplier;
  const output = (usage.outputTokens / 1_000_000) * prices.outputPerMillion * peakMultiplier;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    total: input + output + cacheRead,
  };
}

/** 工具入参归一化：query 去除首尾空白 */
export function normalizeQuery(query: string): string {
  return query.trim();
}
