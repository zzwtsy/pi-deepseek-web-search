// TTL 缓存单元测试：命中、过期、清理、容量统计。
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  it("set/get 命中", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("a", "value");
    expect(cache.get("a")).toBe("value");
  });

  it("未命中返回 undefined", () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("过期后视为未命中并清除条目", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>(100);
      cache.set("a", "value");
      expect(cache.get("a")).toBe("value");
      vi.advanceTimersByTime(101);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear 清空全部", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("size 只统计有效条目", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>(100);
      cache.set("a", "1");
      cache.set("b", "2");
      vi.advanceTimersByTime(101);
      cache.set("c", "3"); // 新条目未过期
      expect(cache.size()).toBe(1);
      expect(cache.get("c")).toBe("3");
    } finally {
      vi.useRealTimers();
    }
  });
});
