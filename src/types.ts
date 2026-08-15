import type { Static } from "typebox";
// 工具输入/输出类型：导出 schema 与输入类型，供 isToolCallEventType 类型化与渲染层使用。
import type { ToolDetails } from "./format.js";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** deepseek_web_search 工具参数 schema */
export const deepseekWebSearchSchema = Type.Object({
  query: Type.String({ description: "The search query." }),
  mode: Type.Optional(
    StringEnum(["answer", "results"] as const, { description: "answer: full synthesized answer with citations; results: compact answer only." }),
  ),
});

export type DeepSeekWebSearchInput = Static<typeof deepseekWebSearchSchema>;

/** 工具返回的 details 结构（供 TUI 渲染与调试）——由 format.ToolDetails 承担，此处保留别名以维持公共 API */
export type DeepSeekWebSearchDetails = ToolDetails;
