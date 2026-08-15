// render.ts —— TUI 渲染层：renderCall/renderResult（纯展示，不参与核心逻辑；主题一律取自 theme 回调）。
// 注意：不直接依赖 @earendil-works/pi-agent-core（非直接依赖，pnpm 下解析不到）；
// 用本地结构化类型描述工具结果，参数逆变保证与 ToolDefinition 的签名兼容。
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { DeepSeekWebSearchDetails, DeepSeekWebSearchInput } from "./types.js";
import { Text } from "@earendil-works/pi-tui";
import { formatActions } from "./format.js";

/** 工具结果的结构化视图（与 AgentToolResult 兼容的最小面） */
interface RenderableToolResult<T> {
  content: Array<{ type: string; text?: string }>;
  details: T;
  isError?: boolean;
}

/** 展开态回答的最大显示字符数（渲染层限长，不影响返回给模型的内容） */
const EXPANDED_ANSWER_CHARS = 2000;

/** 工具行：标题 + 引号 query */
export function renderCall(args: DeepSeekWebSearchInput, theme: Theme): Component {
  const title = theme.fg("toolTitle", theme.bold("deepseek_web_search "));
  const query = theme.fg("dim", `"${args.query}"`);
  return new Text(`${title}${query}`);
}

/** 工具结果行：执行中（partial）→ 错误态 → 完成（折叠摘要 / 展开详情） */
export function renderResult(
  result: RenderableToolResult<Partial<DeepSeekWebSearchDetails> | { stage?: string }>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Component {
  const contentText = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  const details = result.details as Partial<DeepSeekWebSearchDetails> | undefined;

  // 执行中：onUpdate 推送的阶段文本（"Searching the web..." / "Synthesizing answer..."）
  if (options.isPartial) {
    return new Text(theme.fg("dim", contentText));
  }

  // 取消态：用户取消的搜索，dim 中性样式（区别于成功标记，避免显示成绿色空结果）
  if (details?.cancelled) {
    return new Text(theme.fg("dim", contentText || "Search cancelled"));
  }

  // 错误态：details.error 优先，其次 content 文本
  if (result.isError) {
    const error = (result.details as { error?: unknown } | undefined)?.error;
    const message = typeof error === "string" ? error : (contentText || "Search failed");
    return new Text(theme.fg("error", `✗ ${message}`));
  }

  // 折叠态：成功标记 + 摘要（搜索次数、回答字符数、截断标记）
  if (!options.expanded) {
    const searches = details?.searches?.length ?? 0;
    const chars = details?.answer?.length ?? 0;
    const truncated = details?.truncated ? " [truncated]" : "";
    return new Text(theme.fg("success", `✓ ${searches} searches · ${chars} chars${truncated}`));
  }

  // 展开态：回答全文（渲染限长）+ 搜索动作列表（dim，复用 format.ts 的动作摘要逻辑）
  const answer = (details?.answer ?? "").slice(0, EXPANDED_ANSWER_CHARS);
  const actionLines = formatActions(details?.searches ?? []).map(line => theme.fg("dim", line));
  const actionsText = actionLines.length > 0 ? `\n${actionLines.join("\n")}` : "";
  return new Text(`${answer}${actionsText}`);
}
