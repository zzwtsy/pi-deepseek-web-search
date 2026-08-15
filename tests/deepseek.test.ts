// DeepSeekClient 单元测试：mock fetch，覆盖请求构造、响应解析、错误映射、重试、超时与取消。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildReasoningField, DeepSeekClient } from "../src/deepseek.js";

const API_KEY = "test-key";
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "search-response.json"), "utf8"),
) as Record<string, unknown>;

/** 构造 mock fetchFn：按请求次数返回对应响应 */
function mockFetch(
  handlers: Array<() => Promise<Response> | Response>,
): { fetchFn: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const handler = handlers.shift();
    if (!handler)
      throw new Error("unexpected fetch call");
    return handler();
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch): DeepSeekClient {
  return new DeepSeekClient({ apiKey: API_KEY, fetchFn });
}

describe("DeepSeekClient.search", () => {
  it("解析真实响应：final_answer 文本、过滤 ws_call_id 噪声、usage 映射", async () => {
    const { fetchFn } = mockFetch([() => jsonResponse(200, FIXTURE)]);
    const result = await makeClient(fetchFn).search("今天北京的天气怎么样？");

    expect(result.answer).toContain("多云转阴");
    expect(result.answer).toContain("34℃");
    expect(result.answer).not.toContain("Let me get the latest"); // commentary 被跳过
    expect(result.actions).toEqual([
      { type: "search", queries: ["北京今天天气 天气预报", "北京天气 今日 实时"] },
      { type: "open_page", url: "https://www.weather.com.cn/weather/101010100.shtml" },
      { type: "open_page", url: "https://news.bjd.com.cn/2026/08/01/11895454.shtml" },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 6555,
      outputTokens: 636,
      reasoningTokens: 198,
      cachedTokens: 3200,
      totalTokens: 7191,
    });
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("默认请求体：input 为字符串、web_search 工具、tool_choice 强制搜索、max_output_tokens 4096、无 reasoning 字段", async () => {
    const { fetchFn, calls } = mockFetch([() => jsonResponse(200, { output: [], model: "deepseek-v4-flash" })]);
    await makeClient(fetchFn).search("query");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/responses");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.input).toBe("query");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(body.max_output_tokens).toBe(4096);
    expect(body.reasoning).toBeUndefined(); // 默认 auto → 不传
  });

  it("构造时 model 透传到请求体", async () => {
    const { fetchFn, calls } = mockFetch([() => jsonResponse(200, { output: [], model: "deepseek-v4-pro" })]);
    await new DeepSeekClient({ apiKey: API_KEY, fetchFn, model: "deepseek-v4-pro" }).search("q");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-pro");
  });

  it("reasoningEffort 映射：off/low/high 传字段，auto 不传", async () => {
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ["off", { effort: "none" }],
      ["low", { effort: "low" }],
      ["high", { effort: "high" }],
      ["auto", undefined],
    ];
    for (const [effort, expected] of cases) {
      const { fetchFn, calls } = mockFetch([() => jsonResponse(200, { output: [] })]);
      await makeClient(fetchFn).search("q", { reasoningEffort: effort as never });
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
      if (expected === undefined) {
        expect(body.reasoning).toBeUndefined();
      } else {
        expect(body.reasoning).toEqual(expected);
      }
    }
  });

  it("tool_choice 恒为强制搜索（插件职责即搜索，不可跳过）", async () => {
    const { fetchFn, calls } = mockFetch([() => jsonResponse(200, { output: [] })]);
    await makeClient(fetchFn).search("q");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.tool_choice).toEqual({ type: "web_search" });
  });

  it("buildReasoningField 四态映射", () => {
    expect(buildReasoningField("off")).toEqual({ effort: "none" });
    expect(buildReasoningField("low")).toEqual({ effort: "low" });
    expect(buildReasoningField("high")).toEqual({ effort: "high" });
    expect(buildReasoningField("auto")).toBeUndefined();
    expect(buildReasoningField(undefined)).toBeUndefined();
  });

  it("无 final_answer 时 answer 为空串", async () => {
    const response = {
      output: [
        { type: "message", phase: "commentary", content: [{ type: "output_text", text: "thinking out loud" }] },
      ],
    };
    const { fetchFn } = mockFetch([() => jsonResponse(200, response)]);
    const result = await makeClient(fetchFn).search("q");
    expect(result.answer).toBe("");
    expect(result.actions).toEqual([]);
  });

  it("容错：未知 item 类型与字段缺失被忽略", async () => {
    const response = {
      output: [
        { type: "mystery", foo: 1 },
        null,
        "junk",
        { type: "web_search_call", action: { type: "find_in_page", url: "https://example.com/page#ws_call_id=call_x" } },
        { type: "message", phase: "final_answer", content: [{ type: "output_text", text: "ok" }] },
      ],
    };
    const { fetchFn } = mockFetch([() => jsonResponse(200, response)]);
    const result = await makeClient(fetchFn).search("q");
    expect(result.answer).toBe("ok");
    expect(result.actions).toEqual([{ type: "find_in_page", url: "https://example.com/page" }]);
  });

  it("usage 缺失或残缺时返回 undefined", async () => {
    for (const usage of [undefined, {}, { input_tokens: 1 }]) {
      const { fetchFn } = mockFetch([() => jsonResponse(200, { output: [], usage })]);
      const result = await makeClient(fetchFn).search("q");
      expect(result.usage).toBeUndefined();
    }
  });

  it("401 → invalid_api_key，带服务端错误消息", async () => {
    const { fetchFn } = mockFetch([
      () => jsonResponse(401, { error: { message: "Invalid API key", type: "authentication_error" } }),
    ]);
    await expect(makeClient(fetchFn).search("q")).rejects.toMatchObject({
      code: "invalid_api_key",
      message: "Invalid API key",
    });
  });

  it("402 → insufficient_balance", async () => {
    const { fetchFn } = mockFetch([() => jsonResponse(402, { error: { message: "Insufficient Balance" } })]);
    await expect(makeClient(fetchFn).search("q")).rejects.toMatchObject({ code: "insufficient_balance" });
  });

  it("429 → rate_limited", async () => {
    const { fetchFn } = mockFetch([() => jsonResponse(429, { error: { message: "Too Many Requests" } })]);
    await expect(makeClient(fetchFn).search("q")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("400 → invalid_request，无 body 时用 HTTP 状态码作消息", async () => {
    const { fetchFn } = mockFetch([() => new Response("bad", { status: 400 })]);
    await expect(makeClient(fetchFn).search("q")).rejects.toMatchObject({
      code: "invalid_request",
      message: "HTTP 400",
    });
  });

  it("5xx 重试：第一次 500 第二次 200 → 成功", async () => {
    let attempts = 0;
    const fetchFn = (async () => {
      attempts++;
      if (attempts === 1)
        return jsonResponse(500, { error: { message: "boom" } });
      return jsonResponse(200, { output: [], model: "deepseek-v4-flash" });
    }) as typeof fetch;
    const result = await makeClient(fetchFn).search("q");
    expect(result.answer).toBe("");
    expect(attempts).toBe(2);
  });

  it("5xx 重试耗尽 → server_error", async () => {
    const { fetchFn } = mockFetch([
      () => jsonResponse(500, { error: { message: "boom" } }),
      () => jsonResponse(500, { error: { message: "boom" } }),
      () => jsonResponse(500, { error: { message: "boom" } }),
    ]);
    await expect(makeClient(fetchFn).search("q")).rejects.toMatchObject({ code: "server_error" });
  });

  it("网络错误 → network_error", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(makeClient(fetchFn).search("q")).rejects.toMatchObject({ code: "network_error" });
  });

  it("超时 → timeout（fetch 挂起超过 timeoutMs）", async () => {
    const fetchFn = (async (_url: unknown, init: unknown) => {
      // 模拟真实 fetch 的 signal 行为：abort 时 reject
      const signal = (init as RequestInit).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    await expect(makeClient(fetchFn).search("q", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("外部 signal 中止 → aborted", async () => {
    const fetchFn = (async (_url: unknown, init: unknown) => {
      const signal = (init as RequestInit).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const promise = makeClient(fetchFn).search("q", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });

  it("外部 signal 在重试退避期间中止 → aborted", async () => {
    const fetchFn = (async () => jsonResponse(500, { error: { message: "boom" } })) as typeof fetch;
    const controller = new AbortController();
    const promise = makeClient(fetchFn).search("q", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });

  it("baseUrl 尾部斜杠被剥离，Authorization 头正确", async () => {
    const { fetchFn, calls } = mockFetch([() => jsonResponse(200, { output: [] })]);
    const client = new DeepSeekClient({ apiKey: API_KEY, fetchFn, baseUrl: "https://proxy.example.com/" });
    await client.search("q");
    expect(calls[0].url).toBe("https://proxy.example.com/responses");
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
  });

  it("重试退避期间内部超时 → timeout（不再误报 aborted）", async () => {
    // 5xx 触发退避，timeoutMs 极短使内部定时器在 sleep 期间触发 abort
    const fetchFn = (async () => jsonResponse(500, { error: { message: "boom" } })) as typeof fetch;
    await expect(makeClient(fetchFn).search("q", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("入参已中止的 signal → aborted（不发网络请求）", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { output: [] })) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(makeClient(fetchFn).search("q", { signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
