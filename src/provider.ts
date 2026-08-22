// provider.ts —— 搜索后端抽象（消费者拥有：按业务需要设计，而非按厂商 API）。
// 纯类型 + 错误类，零 IO、零 src 内 import；未来新增后端（如 Anthropic）只实现 SearchProvider。
export type ReasoningEffort = "off" | "low" | "high" | "max";

/** 搜索选项：由调用方从配置映射而来，各后端按需使用 */
export interface SearchOptions {
  /** 推理强度（off 关闭思考以省 token） */
  reasoningEffort?: ReasoningEffort;
  /** 回答最大输出 token 数 */
  maxOutputTokens?: number;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** 外部取消信号（用户取消时透传） */
  signal?: AbortSignal;
}

/** 服务端执行的一次搜索动作 */
export interface WebSearchAction {
  type: "search" | "open_page" | "find_in_page";
  /** search 动作的查询词（已过滤 ws_call_id= 噪声条目） */
  queries?: string[];
  /** open_page 动作的 URL（已剥离 #ws_call_id= 后缀） */
  url?: string;
}

/** token 用量统计（映射到 pi Usage 的输入） */
export interface SearchUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

/** 一次搜索的产物：综合回答 + 动作记录 */
export interface SearchResult {
  /** final_answer message 的拼接文本（可能为空串，此时说明响应异常） */
  answer: string;
  /** 服务端执行的搜索动作序列 */
  actions: WebSearchAction[];
  usage?: SearchUsage;
  model: string;
  id?: string;
}

/** 峰谷定价覆盖（可选）。官方定义：高峰 = 平时 × multiplier，时段按北京时间判断 */
export interface PeakPriceConfig {
  /** 高峰单价 = 平峰单价 × multiplier */
  multiplier: number;
  /** 高峰时段列表（北京时间），半开区间 [start, end)，如 [["09:00", "12:00"], ["14:00", "18:00"]] */
  hours: Array<[string, string]>;
  /** 官方规则生效后周末全天按平峰计价；自定义价格表可显式关闭 */
  weekendOffPeak?: boolean;
}

/** 按模型覆盖的价格（models 表的值；字段可选 = 部分覆盖，缺省项回退顶层价格；禁止再嵌套 models） */
export interface ModelPriceConfig {
  /** 输入单价（缓存未命中） */
  inputPerMillion?: number;
  /** 输入单价（缓存命中） */
  cachedInputPerMillion?: number;
  /** 输出单价 */
  outputPerMillion?: number;
  /** 峰谷覆盖：不配置 = 回退顶层 peak */
  peak?: PeakPriceConfig;
}

/** 价格配置：USD / 1M tokens（官方空闲价：deepseek-v4-flash 为 0.22 / 0.007 / 0.66；deepseek-v4-pro 见 models 默认表） */
export interface PriceConfig {
  /** 输入单价（缓存未命中） */
  inputPerMillion: number;
  /** 输入单价（缓存命中） */
  cachedInputPerMillion: number;
  /** 输出单价 */
  outputPerMillion: number;
  /** 峰谷覆盖：不配置 = 全时段平峰价 */
  peak?: PeakPriceConfig;
  /** 按模型覆盖的价格表（key = 模型名，命中优先；整块覆盖，不逐 key 合并） */
  models?: Record<string, ModelPriceConfig>;
}

/** 搜索失败原因（判别联合，供上层按类型处理） */
export type SearchErrorCode
  = | "invalid_api_key"
    | "insufficient_balance"
    | "rate_limited"
    | "server_error"
    | "network_error"
    | "timeout"
    | "aborted"
    | "invalid_request"
    | "unknown";

/** 搜索失败的错误（code 为判别联合，上层据此区分取消/限流/余额等场景） */
export class SearchError extends Error {
  code: SearchErrorCode;

  constructor(message: string, code: SearchErrorCode) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

/** 搜索后端抽象：业务只依赖该接口，具体实现（如 DeepSeek /responses）是适配器 */
export interface SearchProvider {
  /** 稳定标识，写入 details 供用户区分后端，如 "deepseek-responses" */
  readonly id: string;
  /** 执行一次联网搜索，返回综合回答与搜索动作记录 */
  search: (query: string, options: SearchOptions) => Promise<SearchResult>;
}
