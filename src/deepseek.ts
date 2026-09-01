import type { ReasoningEffort, SearchErrorCode, SearchOptions, SearchProvider, SearchResult, SearchUsage, WebSearchAction } from "./provider.js";
import { SearchError } from "./provider.js";
// deepseek.ts —— DeepSeek /responses API 适配器：实现 SearchProvider 端口。
// 唯一知道 DeepSeek 协议/HTTP 细节的文件；领域类型与错误定义见 provider.ts。
// 实测要点（见 docs/api/Search.md）：
//   - web_search_call.action.queries 是数组且混入 "ws_call_id=..." 内部参数，需过滤
//   - open_page 的 url 带 "#ws_call_id=..." 后缀，需剥离
//   - 旧响应的 message 有 phase 字段：只取 "final_answer"，跳过 "commentary"（思考外显文本）
//   - 正式响应可能不含 phase：回退到最后一个已完成的 assistant message

export interface DeepSeekClientOptions {
  /** 默认 https://api.deepseek.com */
  baseUrl?: string;
  apiKey: string;
  /** 注入 fetch 实现以便测试（默认全局 fetch） */
  fetchFn?: typeof fetch;
  /** 默认模型；deepseek-v4-flash 与 deepseek-v4-pro 均支持 /responses */
  model?: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

/** 过滤查询数组中的 ws_call_id= 噪声条目 */
function cleanQueries(queries: unknown): string[] | undefined {
  if (!Array.isArray(queries))
    return undefined;
  const cleaned = queries
    .filter((q): q is string => typeof q === "string")
    .filter(q => !q.startsWith("ws_call_id="));
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 剥离 URL 上的 #ws_call_id= 后缀 */
function cleanUrl(url: unknown): string | undefined {
  if (typeof url !== "string")
    return undefined;
  return url.split("#ws_call_id=")[0] ?? undefined;
}

/** reasoningEffort → 请求体 reasoning 字段（undefined 时返回 undefined，不传该字段并使用 API 默认值） */
export function buildReasoningField(effort?: ReasoningEffort): { effort: string } | undefined {
  switch (effort) {
    case "off":
      return { effort: "none" };
    case "low":
      return { effort: "low" };
    case "high":
      return { effort: "high" };
    case "max":
      return { effort: "max" };
    case undefined:
      return undefined;
  }
}

/** 解析 web_search_call item（容错：字段缺失不抛错） */
function parseWebSearchCall(item: { action?: unknown }): WebSearchAction | undefined {
  if (item.action == null || typeof item.action !== "object")
    return undefined;
  const action = item.action as { type?: unknown; queries?: unknown; url?: unknown };
  if (typeof action.type !== "string")
    return undefined;
  if (action.type === "search") {
    return { type: "search", queries: cleanQueries(action.queries) };
  }
  if (action.type === "open_page" || action.type === "find_in_page") {
    return { type: action.type, url: cleanUrl(action.url) };
  }
  return undefined;
}

/** 从 message content 中拼接 output_text */
function extractMessageText(item: { content?: unknown }): string {
  if (!Array.isArray(item.content))
    return "";
  const parts: string[] = [];
  for (const part of item.content) {
    if (part == null || typeof part !== "object")
      continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "output_text" && typeof p.text === "string")
      parts.push(p.text);
  }
  return parts.join("");
}

/** 从响应 output 中提取最终回答，兼容有 phase 的旧结构与无 phase 的正式结构 */
function extractFinalAnswer(output: unknown[]): string {
  const messages = output.filter((item): item is {
    type: "message";
    phase?: unknown;
    role?: unknown;
    status?: unknown;
    content?: unknown;
  } => item != null && typeof item === "object" && (item as { type?: unknown }).type === "message");

  if (messages.some(message => message.phase !== undefined)) {
    return messages
      .filter(message => message.phase === "final_answer")
      .map(extractMessageText)
      .join("");
  }

  const message = messages.findLast(item =>
    (item.role === undefined || item.role === "assistant")
    && (item.status === undefined || item.status === "completed"));
  return message == null ? "" : extractMessageText(message);
}

/** 解析 usage（容错：字段缺失时返回 undefined） */
function parseUsage(usage: unknown): SearchUsage | undefined {
  if (usage == null || typeof usage !== "object")
    return undefined;
  const u = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") {
    return undefined;
  }
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    reasoningTokens: typeof u.output_tokens_details?.reasoning_tokens === "number" ? u.output_tokens_details.reasoning_tokens : 0,
    cachedTokens: typeof u.input_tokens_details?.cached_tokens === "number" ? u.input_tokens_details.cached_tokens : 0,
    totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : u.input_tokens + u.output_tokens,
  };
}

/** HTTP 状态码 → 错误码映射 */
function mapHttpError(status: number): SearchErrorCode {
  switch (status) {
    case 401:
      return "invalid_api_key";
    case 402:
      return "insufficient_balance";
    case 429:
      return "rate_limited";
    case 400:
    case 422:
      return "invalid_request";
    default:
      return status >= 500 ? "server_error" : "unknown";
  }
}

/** 从错误响应 body 提取 message（DeepSeek 格式 {"error": {"message": ...}}） */
function extractErrorMessage(body: unknown): string | undefined {
  if (body == null || typeof body !== "object")
    return undefined;
  const err = (body as { error?: unknown }).error;
  if (err == null || typeof err !== "object")
    return undefined;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" ? msg : undefined;
}

/** 可取消的延时（用于重试退避） */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // 已中止的 signal 不会再派发 abort 事件，需在此直接失败，避免空等整个退避时间
  if (signal?.aborted)
    throw new Error("sleep aborted");
  return new Promise((resolve, reject) => {
    let onAbort: () => void;
    // 正常计时结束：解除监听，避免残留引用
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // 抛普通 Error 而非 SearchError：调用方 catch 依据 options.signal / controller.signal 区分取消来源
      reject(new Error("sleep aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DeepSeekClient implements SearchProvider {
  readonly id = "deepseek-responses";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly model: string;

  constructor(options: DeepSeekClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  /**
   * 执行一次联网搜索。
   * 服务端执行 search/open_page 等动作并生成综合回答，返回回答文本与动作记录。
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    // 入口守卫：signal 已中止时直接抛出 aborted，不再发网络请求（addEventListener 不会对历史 abort 触发）
    if (options.signal?.aborted)
      throw new SearchError("Request aborted", "aborted");

    const body = this.buildRequestBody(query, options);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 合并外部 signal 与内部超时，并区分取消来源
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await this.fetchFn(`${this.baseUrl}/responses`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (response.status === 200) {
            const json = (await response.json()) as Record<string, unknown>;
            return this.parseResponse(json);
          }

          // 5xx 且未用尽重试次数时退避重试；其余状态直接映射错误
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, controller.signal);
            continue;
          }

          let rawBody: unknown;
          try {
            rawBody = await response.json();
          } catch {
            rawBody = undefined;
          }
          const message = extractErrorMessage(rawBody) ?? `HTTP ${response.status}`;
          throw new SearchError(message, mapHttpError(response.status));
        } catch (error) {
          if (error instanceof SearchError)
            throw error;
          // 区分取消来源：外部 signal → aborted；内部超时 → timeout
          if (options.signal?.aborted)
            throw new SearchError("Request aborted", "aborted");
          if (controller.signal.aborted)
            throw new SearchError(`Request timed out after ${timeoutMs}ms`, "timeout");
          throw new SearchError(`Network error: ${(error as Error).message}`, "network_error");
        }
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 构造 /responses 请求体：搜索恒为强制（插件职责即搜索，不让模型跳过） */
  private buildRequestBody(query: string, options: SearchOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: query,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      max_output_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
    const reasoning = buildReasoningField(options.reasoningEffort);
    if (reasoning)
      body.reasoning = reasoning;
    return body;
  }

  /** 解析 /responses 成功响应 */
  private parseResponse(json: Record<string, unknown>): SearchResult {
    const status = json.status;
    if (status === "failed") {
      throw new SearchError(extractErrorMessage(json) ?? "DeepSeek response failed.", "response_failed");
    }
    if (status !== undefined && status !== "completed" && status !== "incomplete") {
      const label = typeof status === "string" ? status : JSON.stringify(status);
      throw new SearchError(`Unexpected DeepSeek response status: ${label}.`, "response_failed");
    }

    const output = Array.isArray(json.output) ? json.output : [];
    const actions: WebSearchAction[] = [];
    for (const item of output) {
      if (item == null || typeof item !== "object")
        continue;
      const action = parseWebSearchCall(item as { action?: unknown });
      if (action != null)
        actions.push(action);
    }
    const answer = extractFinalAnswer(output);
    const incompleteReason = status === "incomplete"
      ? this.parseIncompleteReason(json.incomplete_details)
      : undefined;
    if (status === "incomplete" && answer.trim().length === 0) {
      const suffix = incompleteReason == null ? "." : `: ${incompleteReason}.`;
      throw new SearchError(`DeepSeek response incomplete${suffix}`, "response_incomplete");
    }

    return {
      answer,
      actions,
      usage: parseUsage(json.usage),
      model: typeof json.model === "string" ? json.model : this.model,
      id: typeof json.id === "string" ? json.id : undefined,
      incomplete: status === "incomplete" ? true : undefined,
      incompleteReason,
    };
  }

  /** 提取不完整响应原因，未知结构不阻断部分答案 */
  private parseIncompleteReason(details: unknown): string | undefined {
    if (details == null || typeof details !== "object")
      return undefined;
    const reason = (details as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : undefined;
  }
}
