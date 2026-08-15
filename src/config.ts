import type { ConfigFileShape } from "./config-schema.js";
import type { PriceConfig, ReasoningEffort } from "./provider.js";
import { readFile as defaultReadFile } from "node:fs/promises";
import { homedir as defaultHomedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
// 配置层：读取顺序 环境变量 → 项目 .pi/ 配置文件 → 全局配置文件 → 默认值。
// 字段级 merge：高优先级来源只覆盖其提供的字段。
// 文件结构定义与校验的单一来源在 config-schema.ts（TypeBox），此处只做合并与错误包装。
// 设计为纯函数（注入 env / readFile / 路径），便于单元测试。
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { configFileSchema } from "./config-schema.js";

export const CONFIG_FILE_NAME = "deepseek-web-search.json";
export const GLOBAL_CONFIG_DIR = join(".pi", "agent");

export interface SearchConfig {
  /** DeepSeek API key（来自环境变量或配置文件） */
  apiKey: string;
  /** API 基础地址（自建代理时修改） */
  baseUrl: string;
  /** 模型名（Responses API 开放 deepseek-v4-flash；v4-pro 适配后改这里即切换） */
  model: string;
  /** 推理强度（off 关闭思考以省 token） */
  reasoningEffort: ReasoningEffort;
  /** 回答最大输出 token 数 */
  maxOutputTokens: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 搜索结果缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 返回给 LLM 的文本最大字符数（超出截断） */
  maxResultChars: number;
  /** 价格配置（元/百万 tokens，默认官方平峰价） */
  prices: PriceConfig;
}

/** 配置文件结构（所有字段可选，按优先级与默认值合并） */
export type { ConfigFileShape } from "./config-schema.js";

/** 除 apiKey 外的默认值 */
export const DEFAULT_CONFIG: Omit<SearchConfig, "apiKey"> = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  reasoningEffort: "low",
  maxOutputTokens: 4096,
  timeoutMs: 30_000,
  cacheTtlMs: 300_000,
  maxResultChars: 50_000,
  prices: {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 2,
    // v4-pro 官方价预置：Responses API 适配后切 model 即用
    models: {
      "deepseek-v4-pro": {
        inputPerMillion: 3,
        cachedInputPerMillion: 0.025,
        outputPerMillion: 6,
      },
    },
  },
};

/** 配置缺失/非法时抛出的错误（消息为英文 UI 文本） */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  /** 项目工作目录（用于定位 .pi/deepseek-web-search.json），缺省时跳过项目配置 */
  cwd?: string;
  /** 环境变量表，默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 文件读取函数（可注入 mock），默认 node:fs/promises readFile（utf8） */
  readFile?: (path: string) => Promise<string>;
  /** 用户主目录，默认 os.homedir() */
  homeDir?: string;
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "high", "auto"];

/** 数字字段的环境变量名 → 配置字段名映射 */
const NUMBER_FIELD_ENV_NAMES: Record<string, keyof Pick<SearchConfig, "maxOutputTokens" | "timeoutMs" | "cacheTtlMs" | "maxResultChars">> = {
  DEEPSEEK_MAX_OUTPUT_TOKENS: "maxOutputTokens",
  DEEPSEEK_TIMEOUT_MS: "timeoutMs",
  DEEPSEEK_CACHE_TTL_MS: "cacheTtlMs",
  DEEPSEEK_MAX_RESULT_CHARS: "maxResultChars",
};

/** 校验 peak.hours 的 start < end（半开区间，JSON Schema 无法表达） */
function validatePeakHours(hours: unknown, path: string, source: string): void {
  if (!Array.isArray(hours))
    return;
  for (const item of hours) {
    if (!Array.isArray(item) || item.length !== 2)
      continue;
    const [start, end] = item as [string, string];
    if (start >= end) {
      throw new ConfigError(`Invalid ${path}.hours in ${source}: start must be before end`);
    }
  }
}

/** 校验 schema 表达力之外的字段间约束（JSON Schema 无法表达的例外）：顶层与 per-model 的 peak.hours start < end、models 空 key */
function validateBeyondSchema(body: Record<string, unknown>, source: string): void {
  const prices = body.prices;
  if (prices == null || typeof prices !== "object")
    return;
  const record = prices as Record<string, unknown>;
  const peak = record.peak;
  if (peak != null && typeof peak === "object") {
    validatePeakHours((peak as Record<string, unknown>).hours, "prices.peak", source);
  }
  const models = record.models;
  if (models != null && typeof models === "object" && !Array.isArray(models)) {
    for (const key of Object.keys(models)) {
      if (key.trim() === "") {
        throw new ConfigError(`Invalid prices.models in ${source}: empty model name`);
      }
      // per-model peak 同样要满足 start < end，否则该模型高峰时段永不命中
      const modelPeak = ((models as Record<string, unknown>)[key] as Record<string, unknown> | undefined)?.peak;
      if (modelPeak != null && typeof modelPeak === "object") {
        validatePeakHours((modelPeak as Record<string, unknown>).hours, `prices.models.${key}.peak`, source);
      }
    }
  }
}

/** 把 TypeBox 校验错误格式化为可读消息：instancePath 的 /a/b 转 a.b */
export function formatSchemaError(errors: Array<{ instancePath: string; message?: string }>): string {
  const first = errors[0];
  if (first == null)
    return "Invalid config";
  const path = first.instancePath.split("/").filter(Boolean).join(".") || "/";
  return `Invalid ${path}: ${first.message ?? "invalid value"}`;
}

/** 从 JSON 字符串解析配置文件：语法检查 + TypeBox 校验（$schema 仅供编辑器关联，运行时剥离） */
export function parseConfigFile(raw: string, source: string): ConfigFileShape {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Invalid JSON in ${source}`);
  }
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new ConfigError(`Invalid config file ${source}: expected a JSON object`);
  }
  const record = json as Record<string, unknown>;
  // 先按完整对象校验（含 $schema 字段类型），通过后再剥离 $schema 返回运行时配置
  if (!Check(configFileSchema, record)) {
    throw new ConfigError(formatSchemaError(Errors(configFileSchema, record)));
  }
  validateBeyondSchema(record, source);
  const { $schema: _ignored, ...body } = record;
  return body;
}

/** 尝试读取配置文件，文件不存在时返回 undefined（其他读取错误抛出） */
async function tryReadConfigFile(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<ConfigFileShape | undefined> {
  let raw: string;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
  return parseConfigFile(raw, path);
}

/** 价格类环境变量名 → PriceConfig 字段名映射 */
const PRICE_ENV_NAMES: Record<string, keyof Pick<PriceConfig, "inputPerMillion" | "cachedInputPerMillion" | "outputPerMillion">> = {
  DEEPSEEK_PRICE_INPUT: "inputPerMillion",
  DEEPSEEK_PRICE_CACHED_INPUT: "cachedInputPerMillion",
  DEEPSEEK_PRICE_OUTPUT: "outputPerMillion",
};

/** 从环境变量读取配置（非法值抛错，未设置返回 undefined 字段） */
function configFromEnv(env: NodeJS.ProcessEnv): ConfigFileShape {
  const shape: ConfigFileShape = {};
  if (env.DEEPSEEK_API_KEY !== undefined)
    shape.apiKey = env.DEEPSEEK_API_KEY;
  if (env.DEEPSEEK_BASE_URL !== undefined)
    shape.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.DEEPSEEK_MODEL !== undefined) {
    if (env.DEEPSEEK_MODEL.trim() === "") {
      throw new ConfigError("Invalid DEEPSEEK_MODEL: expected a non-empty model name");
    }
    shape.model = env.DEEPSEEK_MODEL;
  }
  if (env.DEEPSEEK_REASONING_EFFORT !== undefined) {
    if (!REASONING_EFFORTS.includes(env.DEEPSEEK_REASONING_EFFORT as ReasoningEffort)) {
      throw new ConfigError(`Invalid DEEPSEEK_REASONING_EFFORT: expected ${REASONING_EFFORTS.join("/")}`);
    }
    shape.reasoningEffort = env.DEEPSEEK_REASONING_EFFORT as ReasoningEffort;
  }
  for (const [envName, field] of Object.entries(NUMBER_FIELD_ENV_NAMES)) {
    const value = env[envName];
    if (value === undefined)
      continue;
    // 严格整数解析：拒绝 "30s"、"30_000" 等含非法字符的值，而非 parseInt 静默截断成错误数值；
    // 同时拒绝超长字符串（Number 会溢出为 Infinity）
    const trimmed = value.trim();
    const num = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isFinite(num) || num <= 0) {
      throw new ConfigError(`Invalid ${envName}: expected a positive integer`);
    }
    shape[field] = num;
  }
  const envPrices: Partial<PriceConfig> = {};
  for (const [envName, field] of Object.entries(PRICE_ENV_NAMES)) {
    const value = env[envName];
    if (value === undefined)
      continue;
    // 严格数字解析：拒绝 "1.5元"、"abc" 等，而非 parseFloat 静默截断；
    // 同时拒绝超长字符串（Number 会溢出为 Infinity）
    const trimmed = value.trim();
    const num = Number(trimmed);
    if (!/^\d+(?:\.\d+)?$/.test(trimmed) || !Number.isFinite(num) || num <= 0) {
      throw new ConfigError(`Invalid ${envName}: expected a positive number`);
    }
    envPrices[field] = num;
  }
  if (Object.keys(envPrices).length > 0) {
    shape.prices = envPrices;
  }
  return shape;
}

/** 字段级合并（prices 需一层深合并：先从 shape 中解构出 prices，避免 Object.assign 整块覆盖默认/其他来源） */
function mergeShape(merged: SearchConfig, shape: ConfigFileShape): void {
  const { prices: shapePrices, ...rest } = shape;
  Object.assign(merged, rest);
  if (shapePrices != null) {
    merged.prices = { ...merged.prices, ...shapePrices };
  }
}

/**
 * 合并多来源配置：默认值 < 全局文件 < 项目文件 < 环境变量。
 * 不校验 apiKey（调用方按需调用 validateConfig）。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<SearchConfig> {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? (async (path: string) => defaultReadFile(path, "utf8"));
  const homeDir = options.homeDir ?? defaultHomedir();

  // prices 需独立对象：深拷贝默认值，避免向外共享模块级 DEFAULT_CONFIG.prices（防调用方误改污染全局）
  const merged: SearchConfig = {
    apiKey: "",
    ...DEFAULT_CONFIG,
    prices: structuredClone(DEFAULT_CONFIG.prices),
  };

  // 全局配置文件：~/.pi/agent/deepseek-web-search.json
  const globalFile = await tryReadConfigFile(join(homeDir, GLOBAL_CONFIG_DIR, CONFIG_FILE_NAME), readFile);
  if (globalFile != null)
    mergeShape(merged, globalFile);

  // 项目配置文件：<cwd>/.pi/deepseek-web-search.json
  if (options.cwd != null) {
    const projectFile = await tryReadConfigFile(join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME), readFile);
    if (projectFile != null)
      mergeShape(merged, projectFile);
  }

  // 环境变量：字段级最高优先级
  mergeShape(merged, configFromEnv(env));

  return merged;
}

/** 校验配置是否可用（要求 apiKey 非空），返回可读错误信息 */
export function validateConfig(config: SearchConfig): string | undefined {
  if (config.apiKey.trim() === "") {
    return "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY or add apiKey to the config file.";
  }
  return undefined;
}

/** 带进程内缓存的配置提供者（扩展内复用；reload 用于 /deepseek-search 命令刷新） */
export class ConfigProvider {
  private cached: SearchConfig | undefined;
  private readonly options: LoadConfigOptions;

  constructor(options: LoadConfigOptions = {}) {
    this.options = options;
  }

  async get(): Promise<SearchConfig> {
    if (this.cached === undefined) {
      this.cached = await loadConfig(this.options);
    }
    return this.cached;
  }

  async reload(): Promise<SearchConfig> {
    this.cached = await loadConfig(this.options);
    return this.cached;
  }
}
