import type { PriceConfig, SearchResult, SearchUsage } from "../src/provider.js";
// 格式化层单元测试：截断、content/details 组装、query 归一化、成本计算。
import { describe, expect, it } from "vitest";
import { buildToolContent, buildToolDetails, computeCost, isPeakTime, normalizeQuery, resolvePrices, truncate } from "../src/format.js";

function makeResult(partial: Partial<SearchResult> = {}): SearchResult {
  return {
    answer: "北京今天多云转阴，最高 34℃，最低 26℃。",
    actions: [
      { type: "search", queries: ["北京天气"] },
      { type: "open_page", url: "https://www.weather.com.cn/weather/101010100.shtml" },
    ],
    model: "deepseek-v4-flash",
    ...partial,
  };
}

describe("truncate", () => {
  it("未超限原样返回", () => {
    const { text, truncated } = truncate("hello", 10);
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("超限截断并加标记", () => {
    const { text, truncated } = truncate("hello world", 5);
    expect(text).toBe("hello\n\n...[truncated]");
    expect(truncated).toBe(true);
  });

  it("边界落在代理对中间时回退一个 UTF-16 单元，不产生孤立代理位", () => {
    const atHighSurrogate = truncate("a😀b", 2);
    expect(atHighSurrogate.text).toBe("a\n\n...[truncated]");
    expect(atHighSurrogate.truncated).toBe(true);

    const firstCharIsEmoji = truncate("😀b", 1);
    expect(firstCharIsEmoji.text).toBe("\n\n...[truncated]");
    expect(firstCharIsEmoji.truncated).toBe(true);
  });
});

describe("buildToolContent", () => {
  it("answer 模式：回答 + 搜索动作记录", () => {
    const { content, truncated } = buildToolContent(makeResult(), { mode: "answer", maxChars: 1000 });
    expect(content).toContain("最高 34℃");
    expect(content).toContain("Search actions:");
    expect(content).toContain("- searched: 北京天气");
    expect(content).toContain("- opened: https://www.weather.com.cn/weather/101010100.shtml");
    expect(truncated).toBe(false);
  });

  it("results 模式：仅回答，无动作记录", () => {
    const { content } = buildToolContent(makeResult(), { mode: "results", maxChars: 1000 });
    expect(content).toContain("最高 34℃");
    expect(content).not.toContain("Search actions:");
  });

  it("answer 模式：空回答时返回动作摘要", () => {
    const { content } = buildToolContent(makeResult({ answer: "" }), { mode: "answer", maxChars: 1000 });
    expect(content).toContain("no usable answer");
    expect(content).toContain("- searched: 北京天气");
  });

  it("answer 模式：空回答且无动作", () => {
    const { content } = buildToolContent(makeResult({ answer: "", actions: [] }), {
      mode: "answer",
      maxChars: 1000,
    });
    expect(content).toContain("no usable answer");
    expect(content).toContain("none");
  });

  it("截断生效（answer 模式）", () => {
    const { content, truncated } = buildToolContent(makeResult(), { mode: "answer", maxChars: 5 });
    expect(content).toContain("[truncated]");
    expect(truncated).toBe(true);
  });
});

describe("buildToolDetails", () => {
  it("组装完整 details（截断后 answer 与 content 同源）", () => {
    const result = makeResult();
    const details = buildToolDetails(
      result,
      { query: "北京天气", mode: "answer", cached: true, durationMs: 123 },
      1000,
    );
    expect(details.query).toBe("北京天气");
    expect(details.mode).toBe("answer");
    expect(details.cached).toBe(true);
    expect(details.durationMs).toBe(123);
    expect(details.truncated).toBe(false);
    expect(details.answer).toBe(result.answer);
    expect(details.searches).toHaveLength(2);
    expect(details.model).toBe("deepseek-v4-flash");
  });

  it("超长回答被截断并标记", () => {
    const details = buildToolDetails(makeResult({ answer: "a".repeat(200) }), {
      query: "q",
      mode: "answer",
      cached: false,
      durationMs: 0,
    }, 100);
    expect(details.truncated).toBe(true);
    expect(details.answer).toContain("[truncated]");
  });
});

describe("normalizeQuery", () => {
  it("去除首尾空白", () => {
    expect(normalizeQuery("  hello  ")).toBe("hello");
    expect(normalizeQuery("hello")).toBe("hello");
  });
});

/** 默认空闲价格（与 DEFAULT_CONFIG 一致） */
const DEFAULT_PRICES: PriceConfig = {
  inputPerMillion: 1.5,
  cachedInputPerMillion: 0.05,
  outputPerMillion: 4.5,
};

/** 官方高峰时段（北京时间每日） */
const PEAK_HOURS: Array<[string, string]> = [["09:00", "12:00"], ["14:00", "18:00"]];

/** 构造北京时间指定时刻的 Date（UTC+8） */
function beijingTime(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, day, hour - 8, minute));
}

function makeUsage(partial: Partial<SearchUsage> = {}): SearchUsage {
  return { inputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 0, cachedTokens: 200_000, totalTokens: 1_500_000, ...partial };
}

describe("isPeakTime", () => {
  it("整点边界：09:00/14:00 为高峰，12:00/18:00 为平峰（半开区间）", () => {
    // 2026-08-03 周一
    expect(isPeakTime(beijingTime(3, 9), PEAK_HOURS)).toBe(true);
    expect(isPeakTime(beijingTime(3, 12), PEAK_HOURS)).toBe(false);
    expect(isPeakTime(beijingTime(3, 14), PEAK_HOURS)).toBe(true);
    expect(isPeakTime(beijingTime(3, 18), PEAK_HOURS)).toBe(false);
  });

  it("高峰时段为每日（周末同样生效）", () => {
    // 2026-08-08 周六
    expect(isPeakTime(beijingTime(8, 9, 30), PEAK_HOURS)).toBe(true);
    expect(isPeakTime(beijingTime(8, 20), PEAK_HOURS)).toBe(false);
  });

  it("深夜/清晨不在高峰（含 24:00 归一化）", () => {
    expect(isPeakTime(beijingTime(3, 0, 0), PEAK_HOURS)).toBe(false);
    expect(isPeakTime(beijingTime(3, 0, 1), PEAK_HOURS)).toBe(false);
    expect(isPeakTime(beijingTime(3, 8, 59), PEAK_HOURS)).toBe(false);
  });
});

describe("computeCost", () => {
  it("默认空闲价：未命中输入 1.5 元/百万、命中 0.05、输出 4.5", () => {
    const cost = computeCost(makeUsage(), DEFAULT_PRICES, beijingTime(3, 10));
    expect(cost.input).toBeCloseTo(1.2); // (1M - 200k) / 1M × 1.5
    expect(cost.cacheRead).toBeCloseTo(0.01); // 200k / 1M × 0.05
    expect(cost.output).toBeCloseTo(2.25); // 500k / 1M × 4.5
    expect(cost.total).toBeCloseTo(3.46);
    expect(cost.cacheWrite).toBe(0);
  });

  it("不配置 peak 时全时段空闲价", () => {
    const cost = computeCost(makeUsage(), DEFAULT_PRICES, beijingTime(3, 10));
    const costNight = computeCost(makeUsage(), DEFAULT_PRICES, beijingTime(3, 22));
    expect(cost.total).toBeCloseTo(costNight.total);
  });

  it("配置 peak 且处于高峰时段：所有计费项 × multiplier", () => {
    const prices: PriceConfig = { ...DEFAULT_PRICES, peak: { multiplier: 2, hours: PEAK_HOURS } };
    const peak = computeCost(makeUsage(), prices, beijingTime(3, 10));
    const off = computeCost(makeUsage(), prices, beijingTime(3, 22));
    expect(peak.total).toBeCloseTo(off.total * 2);
    expect(peak.input).toBeCloseTo(2.4);
    expect(peak.cacheRead).toBeCloseTo(0.02);
    expect(peak.output).toBeCloseTo(4.5);
  });

  it("配置 peak 但不在高峰时段：按平峰价", () => {
    const prices: PriceConfig = { ...DEFAULT_PRICES, peak: { multiplier: 2, hours: PEAK_HOURS } };
    const cost = computeCost(makeUsage(), prices, beijingTime(3, 12));
    expect(cost.total).toBeCloseTo(3.46);
  });

  it("零 token：成本全 0", () => {
    const cost = computeCost(makeUsage({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), DEFAULT_PRICES);
    expect(cost.total).toBe(0);
  });

  it("cachedTokens 超过 inputTokens 时未命中部分钳为 0（防御性）", () => {
    const cost = computeCost(makeUsage({ inputTokens: 100, cachedTokens: 500 }), DEFAULT_PRICES);
    expect(cost.input).toBe(0);
    expect(cost.cacheRead).toBeCloseTo(0.000025);
  });

  it("自定义价格生效", () => {
    const prices: PriceConfig = { inputPerMillion: 3, cachedInputPerMillion: 0.5, outputPerMillion: 6 };
    const cost = computeCost(makeUsage(), prices);
    expect(cost.input).toBeCloseTo(2.4);
    expect(cost.cacheRead).toBeCloseTo(0.1);
    expect(cost.output).toBeCloseTo(3);
  });
});

describe("resolvePrices", () => {
  const BASE: PriceConfig = {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 2,
    peak: { multiplier: 2, hours: [["09:00", "12:00"]] },
  };

  it("未配 models 时返回等价但不含 models 的新对象", () => {
    const resolved = resolvePrices(BASE, "deepseek-v4-flash");
    expect(resolved).toEqual(BASE);
    expect("models" in resolved).toBe(false);
  });

  it("未知模型回退顶层价格（同样不含 models）", () => {
    const prices: PriceConfig = { ...BASE, models: { "deepseek-v4-pro": { outputPerMillion: 6 } } };
    const resolved = resolvePrices(prices, "unknown-model");
    expect(resolved.inputPerMillion).toBe(1);
    expect(resolved.cachedInputPerMillion).toBe(0.02);
    expect(resolved.outputPerMillion).toBe(2);
    expect(resolved.peak).toEqual(BASE.peak);
    expect("models" in resolved).toBe(false);
  });

  it("命中 models 表：覆盖字段生效，缺省字段回退顶层", () => {
    const prices: PriceConfig = { ...BASE, models: { "deepseek-v4-pro": { outputPerMillion: 6 } } };
    const resolved = resolvePrices(prices, "deepseek-v4-pro");
    expect(resolved.inputPerMillion).toBe(1);
    expect(resolved.cachedInputPerMillion).toBe(0.02);
    expect(resolved.outputPerMillion).toBe(6);
  });

  it("覆盖价未配 peak 回退顶层 peak，配了则用覆盖 peak", () => {
    const prices: PriceConfig = {
      ...BASE,
      models: {
        a: { outputPerMillion: 6 },
        b: { outputPerMillion: 7, peak: { multiplier: 3, hours: [["10:00", "11:00"]] } },
      },
    };
    expect(resolvePrices(prices, "a").peak).toEqual(BASE.peak);
    expect(resolvePrices(prices, "b").peak).toEqual({ multiplier: 3, hours: [["10:00", "11:00"]] });
  });

  it("解析结果不含 models 字段（可直接传 computeCost）", () => {
    const resolved = resolvePrices({ ...BASE, models: { a: { outputPerMillion: 6 } } }, "a");
    expect("models" in resolved).toBe(false);
  });

  it("与 computeCost 联动：pro 覆盖价参与成本计算", () => {
    const prices: PriceConfig = {
      ...BASE,
      models: {
        "deepseek-v4-pro": { inputPerMillion: 4.5, cachedInputPerMillion: 0.15, outputPerMillion: 13.5 },
      },
    };
    const cost = computeCost(makeUsage(), resolvePrices(prices, "deepseek-v4-pro"));
    expect(cost.input).toBeCloseTo(3.6);
    expect(cost.cacheRead).toBeCloseTo(0.03);
    expect(cost.output).toBeCloseTo(6.75);
  });
});
