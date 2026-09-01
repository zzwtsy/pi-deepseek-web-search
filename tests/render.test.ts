// TUI 渲染测试：部分响应在折叠与展开状态都必须显示 warning。
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { renderResult } from "../src/render.js";

function render(expanded: boolean): {
  output: string;
  fg: ReturnType<typeof vi.fn<(color: string, text: string) => string>>;
} {
  const fg = vi.fn((_color: string, text: string) => text);
  const theme = { fg } as unknown as Theme;
  const component = renderResult({
    content: [{ type: "text", text: "partial answer" }],
    details: {
      query: "q",
      mode: "answer",
      searches: [{ type: "search", queries: ["q"] }],
      answer: "partial answer",
      truncated: false,
      cached: false,
      durationMs: 20,
      model: "deepseek-v4-flash",
      incomplete: true,
      incompleteReason: "max_output_tokens",
    },
  }, { expanded, isPartial: false }, theme);
  return { output: component.render(120).join("\n"), fg };
}

describe("renderResult incomplete", () => {
  it("折叠态使用 warning，而不是 success", () => {
    const { output, fg } = render(false);
    expect(output).toContain("⚠ 1 searches · 14 chars · incomplete (max_output_tokens)");
    expect(fg).toHaveBeenCalledWith("warning", expect.any(String));
    expect(fg).not.toHaveBeenCalledWith("success", expect.any(String));
  });

  it("展开态在答案前显示 warning", () => {
    const { output, fg } = render(true);
    const warning = "[Response incomplete: max_output_tokens. The answer may be truncated.]";
    expect(output).toContain(warning);
    expect(output.indexOf(warning)).toBeLessThan(output.indexOf("partial answer"));
    expect(fg).toHaveBeenCalledWith("warning", warning);
  });
});
