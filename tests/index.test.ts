// 入口层单元测试：execute() 的 usage 核算、缓存命中、取消分类与 query 校验（mock config 读取与 fetch）。
import type { SearchConfig } from "../src/config.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigProvider } from "../src/config.js";
import registerExtension from "../src/index.js";
import { SearchError } from "../src/provider.js";

/** 最小可用的 /responses 成功响应体（usage 与 fixture 一致：input_tokens 已含 cached_tokens） */
function successBody(): Record<string, unknown> {
  return {
    output: [
      {
        type: "message",
        phase: "final_answer",
        content: [{ type: "output_text", text: "北京今天多云转阴。" }],
      },
    ],
    usage: {
      input_tokens: 6555,
      output_tokens: 636,
      total_tokens: 7191,
      input_tokens_details: { cached_tokens: 3200 },
      output_tokens_details: { reasoning_tokens: 198 },
    },
    model: "deepseek-v4-flash",
    id: "resp_1",
  };
}

/** 包含部分答案的 /responses 响应体 */
function incompleteBody(): Record<string, unknown> {
  return {
    ...successBody(),
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  };
}

const DEFAULT_TEST_CONFIG: SearchConfig = {
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  maxOutputTokens: 4096,
  timeoutMs: 30_000,
  cacheTtlMs: 300_000,
  maxResultChars: 50_000,
  prices: {
    inputPerMillion: 0.22,
    cachedInputPerMillion: 0.007,
    outputPerMillion: 0.66,
    peak: { multiplier: 2, hours: [["09:00", "12:00"], ["14:00", "18:00"]] },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ToolDef {
  parameters?: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: {
      cwd: string;
      modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
    },
  ) => Promise<Record<string, unknown>>;
}

interface CommandDef {
  handler: (args: string, ctx: { cwd: string; modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> } }) => Promise<void>;
}

let tool: ToolDef;
let command: CommandDef;
let mockConfig: SearchConfig;
let fetchFn: ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>>;
let getPiApiKey: ReturnType<typeof vi.fn<(provider: string) => Promise<string | undefined>>>;
let sendMessage: ReturnType<typeof vi.fn>;

function makeCtx(cwd: string): {
  cwd: string;
  modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
} {
  return { cwd, modelRegistry: { getApiKeyForProvider: getPiApiKey } };
}

beforeEach(() => {
  const tools: ToolDef[] = [];
  sendMessage = vi.fn();
  const pi = {
    registerTool: (def: ToolDef) => tools.push(def),
    registerCommand: (_name: string, def: CommandDef) => {
      command = def;
    },
    sendMessage,
  } as unknown as Parameters<typeof registerExtension>[0];
  registerExtension(pi);
  tool = tools[0];

  mockConfig = { ...DEFAULT_TEST_CONFIG, prices: { ...DEFAULT_TEST_CONFIG.prices } };
  vi.spyOn(ConfigProvider.prototype, "get").mockImplementation(async () => mockConfig);
  vi.spyOn(ConfigProvider.prototype, "reload").mockImplementation(async () => mockConfig);

  fetchFn = vi.fn(async () => jsonResponse(200, successBody()));
  getPiApiKey = vi.fn(async (_provider: string) => undefined);
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("deepseek_web_search execute", () => {
  it("未命中：返回 usage，input = inputTokens - cachedTokens（不重复计数）", async () => {
    const result = await tool.execute("id", { query: "北京天气" }, undefined, undefined, makeCtx("/tmp/ds-t1"));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.usage).toMatchObject({
      input: 3355, // 6555 - 3200
      cacheRead: 3200,
      output: 636,
      reasoning: 198,
      totalTokens: 7191,
    });
  });

  it("成本按请求发起时间计费，而不是响应完成时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 24, 3, 59, 59))); // 北京时间周一 11:59:59
    let resolveFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    fetchFn.mockImplementation(async () => {
      resolveFetchStarted();
      await new Promise<void>(resolve => setTimeout(resolve, 1_000)); // 跨过 12:00 平峰边界
      return jsonResponse(200, successBody());
    });

    const resultPromise = tool.execute("id", { query: "跨越峰值边界" }, undefined, undefined, makeCtx("/tmp/ds-billing-time"));
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;
    const usage = result.usage as { cost: { total: number } };
    expect(usage.cost.total).toBeCloseTo(0.00236052, 8);
  });

  it("未配置 apiKey 时回退使用 pi 已配置的 DeepSeek key", async () => {
    mockConfig = { ...mockConfig, apiKey: "" };
    getPiApiKey.mockResolvedValue("sk-pi-deepseek");
    await tool.execute("id", { query: "使用 pi key" }, undefined, undefined, makeCtx("/tmp/ds-use-pi-key"));
    expect(getPiApiKey).toHaveBeenCalledWith("deepseek");
    const init = fetchFn.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-pi-deepseek" });
  });

  it("缓存命中：不返回顶层 usage（避免会话成本重复累计），details 保留首次原始记录", async () => {
    const first = await tool.execute("id", { query: "同一查询" }, undefined, undefined, makeCtx("/tmp/ds-t2"));
    const second = await tool.execute("id", { query: "同一查询" }, undefined, undefined, makeCtx("/tmp/ds-t2"));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.usage).toBeUndefined();
    expect((second.details as { cached: boolean }).cached).toBe(true);
    expect((second.details as { usage?: unknown }).usage).toEqual((first.details as { usage?: unknown }).usage);
  });

  it("incomplete 返回内容、details 与 usage，但同一查询不会缓存", async () => {
    fetchFn.mockImplementation(async () => jsonResponse(200, incompleteBody()));
    const first = await tool.execute("id", { query: "部分答案" }, undefined, undefined, makeCtx("/tmp/ds-incomplete"));
    const second = await tool.execute("id", { query: "部分答案" }, undefined, undefined, makeCtx("/tmp/ds-incomplete"));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(first.usage).toMatchObject({ input: 3355, output: 636, totalTokens: 7191 });
    expect(first.details).toMatchObject({
      cached: false,
      incomplete: true,
      incompleteReason: "max_output_tokens",
    });
    expect(second.details).toMatchObject({ cached: false, incomplete: true });
    const content = first.content as Array<{ type?: string; text?: string }>;
    expect(content[0]?.text).toContain("[Response incomplete: max_output_tokens. The answer may be truncated.]");
  });

  it("不同 cwd 下相同查询不共享缓存", async () => {
    await tool.execute("id", { query: "跨项目查询" }, undefined, undefined, makeCtx("/tmp/ds-cwd-a"));
    await tool.execute("id", { query: "跨项目查询" }, undefined, undefined, makeCtx("/tmp/ds-cwd-b"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborted → cancelled details（不标记为错误）", async () => {
    fetchFn.mockImplementation(() => {
      throw new SearchError("Request aborted", "aborted");
    });
    const result = await tool.execute("id", { query: "取消的查询" }, undefined, undefined, makeCtx("/tmp/ds-t3"));
    expect(result.details).toMatchObject({ cancelled: true });
    const content = result.content as Array<{ type?: string; text?: string }>;
    expect(content[0]?.text).toBe("The web search was cancelled.");
    expect(result.isError).toBeUndefined();
  });

  it("缺失 query → 抛预期的校验错误（而非裸 TypeError）", async () => {
    await expect(tool.execute("id", {}, undefined, undefined, makeCtx("/tmp/ds-t4"))).rejects.toThrow(
      "Query must not be empty.",
    );
  });

  it("schema 不再暴露 maxResults 死参数", () => {
    expect(tool.parameters?.properties?.maxResults).toBeUndefined();
  });

  it("status 展示当前模型解析后的价格", async () => {
    mockConfig = {
      ...mockConfig,
      model: "deepseek-v4-pro",
      prices: {
        inputPerMillion: 0.22,
        cachedInputPerMillion: 0.007,
        outputPerMillion: 0.66,
        models: {
          "deepseek-v4-pro": { inputPerMillion: 0.66, cachedInputPerMillion: 0.022, outputPerMillion: 1.98 },
        },
      },
    };
    await command.handler("status", makeCtx("/tmp/ds-status-price"));
    const message = sendMessage.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(message?.content).toContain("Prices: 0.66/0.022/1.98");
  });
});
