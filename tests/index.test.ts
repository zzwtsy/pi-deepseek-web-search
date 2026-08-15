// 入口层单元测试：execute() 的 usage 核算、缓存命中、取消分类与 query 校验（mock config 读取与 fetch）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/index.js";
import { SearchError } from "../src/provider.js";

// 固定测试配置：隔离真实文件读取（mock 掉 config 模块的 loadConfig）
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    loadConfig: async () => ({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      maxOutputTokens: 4096,
      timeoutMs: 30_000,
      cacheTtlMs: 300_000,
      maxResultChars: 50_000,
      prices: { inputPerMillion: 1.5, cachedInputPerMillion: 0.05, outputPerMillion: 4.5 },
    }),
  };
});

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
    ctx: { cwd: string },
  ) => Promise<Record<string, unknown>>;
}

let tool: ToolDef;
let fetchFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const tools: ToolDef[] = [];
  const pi = {
    registerTool: (def: ToolDef) => tools.push(def),
    registerCommand: () => {},
  } as unknown as Parameters<typeof registerExtension>[0];
  registerExtension(pi);
  tool = tools[0];

  fetchFn = vi.fn(async () => jsonResponse(200, successBody()));
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deepseek_web_search execute", () => {
  it("未命中：返回 usage，input = inputTokens - cachedTokens（不重复计数）", async () => {
    const result = await tool.execute("id", { query: "北京天气" }, undefined, undefined, { cwd: "/tmp/ds-t1" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.usage).toMatchObject({
      input: 3355, // 6555 - 3200
      cacheRead: 3200,
      output: 636,
      reasoning: 198,
      totalTokens: 7191,
    });
  });

  it("缓存命中：不返回顶层 usage（避免会话成本重复累计），details 保留首次原始记录", async () => {
    const first = await tool.execute("id", { query: "同一查询" }, undefined, undefined, { cwd: "/tmp/ds-t2" });
    const second = await tool.execute("id", { query: "同一查询" }, undefined, undefined, { cwd: "/tmp/ds-t2" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.usage).toBeUndefined();
    expect((second.details as { cached: boolean }).cached).toBe(true);
    expect((second.details as { usage?: unknown }).usage).toEqual((first.details as { usage?: unknown }).usage);
  });

  it("不同 cwd 下相同查询不共享缓存", async () => {
    await tool.execute("id", { query: "跨项目查询" }, undefined, undefined, { cwd: "/tmp/ds-cwd-a" });
    await tool.execute("id", { query: "跨项目查询" }, undefined, undefined, { cwd: "/tmp/ds-cwd-b" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborted → cancelled details（不标记为错误）", async () => {
    fetchFn.mockImplementation(() => {
      throw new SearchError("Request aborted", "aborted");
    });
    const result = await tool.execute("id", { query: "取消的查询" }, undefined, undefined, { cwd: "/tmp/ds-t3" });
    expect(result.details).toMatchObject({ cancelled: true });
    const content = result.content as Array<{ type?: string; text?: string }>;
    expect(content[0]?.text).toBe("The web search was cancelled.");
    expect(result.isError).toBeUndefined();
  });

  it("缺失 query → 抛预期的校验错误（而非裸 TypeError）", async () => {
    await expect(tool.execute("id", {}, undefined, undefined, { cwd: "/tmp/ds-t4" })).rejects.toThrow(
      "Query must not be empty.",
    );
  });

  it("schema 不再暴露 maxResults 死参数", () => {
    expect(tool.parameters?.properties?.maxResults).toBeUndefined();
  });
});
