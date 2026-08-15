import type { Static } from "typebox";
import type { PeakPriceConfig, ReasoningEffort } from "./provider.js";
// config-schema.ts —— 配置文件结构的单一事实来源（TypeBox）。
// 派生：① ConfigFileShape 类型（config.ts 经 Static）② 运行时校验（Check/Errors）③ 中/英两份 JSON Schema（pnpm gen:schema）。
// 双语注释约定：descriptionZh（中文）/ descriptionEn（英文），生成时映射为标准 description。
// 说明：reasoningEffort 用 Type.Unsafe 而非 StringEnum（StringEnum 不透传自定义注释键；配置 schema 无 Gemini 兼容约束）。
import { Type } from "typebox";

/** HH:MM 24 小时制（00:00-23:59） */
const TIME_PATTERN = "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$";

/** 峰谷定价覆盖（可选）。官方定义：高峰 = 平峰 × multiplier，时段为北京时间每日 */
export const peakSchema = Type.Object({
  multiplier: Type.Number({
    exclusiveMinimum: 0,
    descriptionZh: "高峰单价倍率（官方规则为 2）。",
    descriptionEn: "Peak multiplier; official value is 2.",
  }),
  hours: Type.Array(
    Type.Tuple([
      Type.String({ pattern: TIME_PATTERN }),
      Type.String({ pattern: TIME_PATTERN }),
    ]),
    {
      minItems: 1,
      descriptionZh: "高峰时段列表，半开区间 [start, end)（09:00 计高峰、12:00 不计）。",
      descriptionEn: "Peak hour ranges, half-open [start, end); 09:00 counts as peak, 12:00 does not.",
    },
  ),
}, {
  additionalProperties: false,
  descriptionZh: "峰谷定价：高峰时段价格 = 平峰 × multiplier（适用所有计费项）。官方定义高峰时段为北京时间每日 9:00-12:00 与 14:00-18:00。",
  descriptionEn: "Peak-hour pricing: peak price = off-peak price × multiplier, applied to all billing items. Official peak hours are 09:00-12:00 and 14:00-18:00 Beijing time daily.",
});

/** 官方默认峰谷配置（北京时间每日 9:00-12:00 / 14:00-18:00，高峰价 = 空闲价 × 2） */
export const DEFAULT_PEAK: PeakPriceConfig = {
  multiplier: 2,
  hours: [["09:00", "12:00"], ["14:00", "18:00"]],
};

/** 带默认值的顶层 peak schema；per-model peak 继续使用无默认值的 peakSchema */
const defaultPeakSchema = Type.Object(peakSchema.properties, {
  additionalProperties: false,
  default: DEFAULT_PEAK,
  descriptionZh: "峰谷定价：高峰时段价格 = 平峰 × multiplier（适用所有计费项）。官方定义高峰时段为北京时间每日 9:00-12:00 与 14:00-18:00。",
  descriptionEn: "Peak-hour pricing: peak price = off-peak price × multiplier, applied to all billing items. Official peak hours are 09:00-12:00 and 14:00-18:00 Beijing time daily.",
});

/** 单模型价格覆盖（部分覆盖：缺省项回退顶层价格；无 models 键 + additionalProperties:false 天然禁止嵌套） */
export const modelPriceSchema = Type.Object({
  inputPerMillion: Type.Optional(Type.Number({
    exclusiveMinimum: 0,
    descriptionZh: "输入单价（缓存未命中）。",
    descriptionEn: "Input price, cache miss.",
  })),
  cachedInputPerMillion: Type.Optional(Type.Number({
    exclusiveMinimum: 0,
    descriptionZh: "输入单价（缓存命中）。",
    descriptionEn: "Input price, cache hit.",
  })),
  outputPerMillion: Type.Optional(Type.Number({
    exclusiveMinimum: 0,
    descriptionZh: "输出单价。",
    descriptionEn: "Output price.",
  })),
  peak: Type.Optional(peakSchema),
}, {
  additionalProperties: false,
  descriptionZh: "单模型价格覆盖：缺省项回退顶层价格。",
  descriptionEn: "Per-model price override; missing fields fall back to top-level prices.",
});

/** 价格配置（USD / 1M tokens，依据官方英文定价页） */
export const pricesSchema = Type.Object({
  inputPerMillion: Type.Optional(Type.Number({
    exclusiveMinimum: 0,
    default: 0.22,
    descriptionZh: "输入单价，缓存未命中，空闲价（USD / 1M tokens）。环境变量 DEEPSEEK_PRICE_INPUT 可覆盖。",
    descriptionEn: "Input price, cache miss, off-peak (USD / 1M tokens). Overridable via DEEPSEEK_PRICE_INPUT.",
  })),
  cachedInputPerMillion: Type.Optional(Type.Number({
    exclusiveMinimum: 0,
    default: 0.007,
    descriptionZh: "输入单价，缓存命中，空闲价（USD / 1M tokens）。环境变量 DEEPSEEK_PRICE_CACHED_INPUT 可覆盖。",
    descriptionEn: "Input price, cache hit, off-peak (USD / 1M tokens). Overridable via DEEPSEEK_PRICE_CACHED_INPUT.",
  })),
  outputPerMillion: Type.Optional(Type.Number({
    exclusiveMinimum: 0,
    default: 0.66,
    descriptionZh: "输出单价，空闲价（USD / 1M tokens）。环境变量 DEEPSEEK_PRICE_OUTPUT 可覆盖。",
    descriptionEn: "Output price, off-peak (USD / 1M tokens). Overridable via DEEPSEEK_PRICE_OUTPUT.",
  })),
  peak: Type.Optional(defaultPeakSchema),
  models: Type.Optional(Type.Record(Type.String(), modelPriceSchema, {
    descriptionZh: "按模型覆盖的价格表（key = 模型名，命中优先；整块替换默认表）。",
    descriptionEn: "Per-model price overrides keyed by model name; a matching model takes precedence. Setting this field replaces the default table as a whole.",
  })),
}, {
  additionalProperties: false,
  descriptionZh: "价格配置，单位：USD / 1M tokens。默认值为官方空闲价，并默认启用官方峰谷时段。",
  descriptionEn: "Pricing in USD per 1M tokens; defaults are the official off-peak prices, and the official peak schedule is enabled by default.",
});

/** 配置文件结构（所有字段可选，按优先级合并）——单一事实来源 */
export const configFileSchema = Type.Object({
  $schema: Type.Optional(Type.String({
    descriptionZh: "JSON Schema 地址，仅供编辑器补全/校验；运行时忽略。",
    descriptionEn: "JSON Schema URL for editor autocomplete/validation only; ignored at runtime.",
  })),
  apiKey: Type.Optional(Type.String({
    minLength: 1,
    descriptionZh: "DeepSeek API key（必填）。优先级：环境变量 DEEPSEEK_API_KEY > 本字段。",
    descriptionEn: "DeepSeek API key (required). Env DEEPSEEK_API_KEY takes precedence.",
  })),
  baseUrl: Type.Optional(Type.String({
    default: "https://api.deepseek.com",
    descriptionZh: "API 基础地址（自建代理时修改）。环境变量 DEEPSEEK_BASE_URL 可覆盖。",
    descriptionEn: "API base URL; change when using a proxy. Overridable via DEEPSEEK_BASE_URL.",
  })),
  model: Type.Optional(Type.String({
    default: "deepseek-v4-flash",
    minLength: 1,
    pattern: "^(?!\\s*$)",
    descriptionZh: "模型名。deepseek-v4-flash 与 deepseek-v4-pro 均支持 Responses API；切换模型后价格自动取 prices.models。环境变量 DEEPSEEK_MODEL 可覆盖。",
    descriptionEn: "Model name. Both deepseek-v4-flash and deepseek-v4-pro support the Responses API; pricing resolves via prices.models when switching models. Overridable via DEEPSEEK_MODEL.",
  })),
  reasoningEffort: Type.Optional(Type.Unsafe<ReasoningEffort>({
    type: "string",
    enum: ["off", "low", "high", "max"],
    default: "high",
    descriptionZh: "推理强度：off 关闭思考（省 token）、low/high/max 控制思考量。官方默认 high。环境变量 DEEPSEEK_REASONING_EFFORT 可覆盖。",
    descriptionEn: "Reasoning effort: off disables thinking, low/high/max control the amount; the official default is high. Overridable via DEEPSEEK_REASONING_EFFORT.",
  })),
  maxOutputTokens: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 384_000,
    default: 4096,
    descriptionZh: "回答最大输出 token 数（官方上限 384K）。环境变量 DEEPSEEK_MAX_OUTPUT_TOKENS 可覆盖。",
    descriptionEn: "Maximum output tokens for the answer; the official limit is 384K. Overridable via DEEPSEEK_MAX_OUTPUT_TOKENS.",
  })),
  timeoutMs: Type.Optional(Type.Integer({
    minimum: 1,
    default: 30_000,
    descriptionZh: "单次请求超时（毫秒）。环境变量 DEEPSEEK_TIMEOUT_MS 可覆盖。",
    descriptionEn: "Request timeout in ms. Overridable via DEEPSEEK_TIMEOUT_MS.",
  })),
  cacheTtlMs: Type.Optional(Type.Integer({
    minimum: 1,
    default: 300_000,
    descriptionZh: "搜索结果缓存 TTL（毫秒）。环境变量 DEEPSEEK_CACHE_TTL_MS 可覆盖。",
    descriptionEn: "Search result cache TTL in ms. Overridable via DEEPSEEK_CACHE_TTL_MS.",
  })),
  maxResultChars: Type.Optional(Type.Integer({
    minimum: 1,
    default: 50_000,
    descriptionZh: "返回给 LLM 的文本最大字符数（超出截断）。环境变量 DEEPSEEK_MAX_RESULT_CHARS 可覆盖。",
    descriptionEn: "Max chars returned to the LLM; longer text is truncated. Overridable via DEEPSEEK_MAX_RESULT_CHARS.",
  })),
  prices: Type.Optional(pricesSchema),
}, {
  additionalProperties: false,
  descriptionZh: "deepseek-web-search 扩展配置文件（.pi/deepseek-web-search.json）。校验规则与运行时一致；默认启用官方峰谷定价（北京时间每日 9:00-12:00 / 14:00-18:00）。",
  descriptionEn: "Config file for the deepseek-web-search extension; validation rules match the runtime. Official peak pricing is enabled by default (daily 09:00-12:00 / 14:00-18:00 Beijing time).",
});

/** 配置文件结构类型（由 configFileSchema 派生，单一来源） */
export type ConfigFileShape = Static<typeof configFileSchema>;

/** 生成某语言版本的 schema 文档（localize 双语注释键 → 标准 description，并补 $schema/title） */
export function buildSchemaDoc(lang: "zh" | "en"): Record<string, unknown> {
  const doc = localize(JSON.parse(JSON.stringify(configFileSchema)), lang) as Record<string, unknown>;
  doc.$schema = "http://json-schema.org/draft-07/schema#";
  doc.title = `deepseek-web-search config (${lang})`;
  doc.description = `Generated by pnpm gen:schema from src/config-schema.ts — do not edit. 由 src/config-schema.ts 自动生成，请勿手改。`;
  return doc;
}

/** 深度遍历：把 descriptionZh/descriptionEn 映射为标准 description（按语言），删除另一个语言键 */
function localize(node: unknown, lang: "zh" | "en"): unknown {
  if (Array.isArray(node))
    return node.map(item => localize(item, lang));
  if (node == null || typeof node !== "object")
    return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "descriptionZh" || key === "descriptionEn") {
      if (key === (lang === "zh" ? "descriptionZh" : "descriptionEn"))
        out.description = value;
    } else {
      out[key] = localize(value, lang);
    }
  }
  return out;
}
