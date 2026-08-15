// 配置层单元测试：优先级（默认 < 全局文件 < 项目文件 < 环境变量）、解析校验、错误处理。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSchemaDoc, configFileSchema } from "../src/config-schema.js";
import { ConfigError, ConfigProvider, DEFAULT_CONFIG, loadConfig, parseConfigFile, validateConfig } from "../src/config.js";

const CONFIG_DIR = ".pi";
const CONFIG_FILE = "deepseek-web-search.json";

/** 写文件并自动创建父目录 */
function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 构造隔离的临时目录（全局 + 项目），返回可注入 loadConfig 的选项 */
function makeDirs(): { homeDir: string; cwd: string; readFile: (p: string) => Promise<string> } {
  const base = mkdtempSync(join(tmpdir(), "ds-config-"));
  const readFileFn = async (p: string) => readFile(p, "utf8");
  return { homeDir: join(base, "home"), cwd: join(base, "project"), readFile: readFileFn };
}

function writeGlobal(dir: { homeDir: string }, config: object) {
  writeFile(join(dir.homeDir, CONFIG_DIR, "agent", CONFIG_FILE), JSON.stringify(config));
}

function writeProject(dir: { cwd: string }, config: object) {
  writeFile(join(dir.cwd, CONFIG_DIR, CONFIG_FILE), JSON.stringify(config));
}

describe("parseConfigFile", () => {
  it("解析合法配置", () => {
    const shape = parseConfigFile(
      JSON.stringify({ apiKey: "sk-1", reasoningEffort: "high", maxOutputTokens: 2048 }),
      "test.json",
    );
    expect(shape).toEqual({ apiKey: "sk-1", reasoningEffort: "high", maxOutputTokens: 2048 });
  });

  it("非法 JSON / 非对象 / 非法字段值抛 ConfigError", () => {
    expect(() => parseConfigFile("not json", "f.json")).toThrow(ConfigError);
    expect(() => parseConfigFile("[1]", "f.json")).toThrow(ConfigError);
    expect(() => parseConfigFile("{}", "f.json")).not.toThrow();
    expect(() => parseConfigFile(JSON.stringify({ reasoningEffort: "ultra" }), "f.json")).toThrow(ConfigError);
    expect(() => parseConfigFile(JSON.stringify({ maxOutputTokens: -1 }), "f.json")).toThrow(ConfigError);
    expect(() => parseConfigFile(JSON.stringify({ maxOutputTokens: 1.5 }), "f.json")).toThrow(ConfigError);
  });
});

describe("loadConfig 优先级", () => {
  it("无任何来源：默认值 + 空 apiKey", async () => {
    const dir = makeDirs();
    const config = await loadConfig({ ...dir, env: {} });
    expect(config).toEqual({ apiKey: "", ...DEFAULT_CONFIG });
  });

  it("全局文件生效", async () => {
    const dir = makeDirs();
    writeGlobal(dir, { apiKey: "sk-global", baseUrl: "https://proxy.example.com" });
    const config = await loadConfig({ ...dir, env: {} });
    expect(config.apiKey).toBe("sk-global");
    expect(config.baseUrl).toBe("https://proxy.example.com");
    expect(config.reasoningEffort).toBe(DEFAULT_CONFIG.reasoningEffort); // 未提供字段保持默认
  });

  it("项目文件覆盖全局文件（字段级）", async () => {
    const dir = makeDirs();
    writeGlobal(dir, { apiKey: "sk-global", reasoningEffort: "low" });
    writeProject(dir, { apiKey: "sk-project" });
    const config = await loadConfig({ ...dir, env: {} });
    expect(config.apiKey).toBe("sk-project");
    expect(config.reasoningEffort).toBe("low"); // 项目未提供，沿用全局
  });

  it("环境变量覆盖配置文件（字段级）", async () => {
    const dir = makeDirs();
    writeGlobal(dir, { apiKey: "sk-global", reasoningEffort: "low" });
    writeProject(dir, { reasoningEffort: "high" });
    const config = await loadConfig({ ...dir, env: { DEEPSEEK_API_KEY: "sk-env", DEEPSEEK_REASONING_EFFORT: "off" } });
    expect(config.apiKey).toBe("sk-env");
    expect(config.reasoningEffort).toBe("off");
  });

  it("cwd 缺省时不读取项目配置", async () => {
    const dir = makeDirs();
    writeProject(dir, { apiKey: "sk-project" });
    const config = await loadConfig({ homeDir: dir.homeDir, readFile: dir.readFile, env: {} });
    expect(config.apiKey).toBe("");
  });

  it("数字字段环境变量解析", async () => {
    const dir = makeDirs();
    const config = await loadConfig({
      ...dir,
      env: { DEEPSEEK_MAX_OUTPUT_TOKENS: "1024", DEEPSEEK_TIMEOUT_MS: "5000" },
    });
    expect(config.maxOutputTokens).toBe(1024);
    expect(config.timeoutMs).toBe(5000);
  });

  it("非法环境变量抛 ConfigError", async () => {
    const dir = makeDirs();
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_REASONING_EFFORT: "ultra" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_TIMEOUT_MS: "abc" } })).rejects.toThrow(ConfigError);
  });

  it("env 数字解析拒绝畸形值（而非 parseInt/parseFloat 静默截断）", async () => {
    const dir = makeDirs();
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_TIMEOUT_MS: "30s" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_TIMEOUT_MS: "30_000" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_MAX_OUTPUT_TOKENS: "4096.5" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_CACHE_TTL_MS: "5m" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_PRICE_INPUT: "1.5元" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_PRICE_OUTPUT: "2x" } })).rejects.toThrow(ConfigError);
    // 超长数字字符串：正则能通过，但 Number() 会溢出为 Infinity，必须拒绝
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_TIMEOUT_MS: "9".repeat(400) } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_PRICE_INPUT: `${"9".repeat(400)}.5` } })).rejects.toThrow(ConfigError);
  });

  it("配置文件 JSON 损坏抛 ConfigError", async () => {
    const dir = makeDirs();
    writeFile(join(dir.homeDir, CONFIG_DIR, "agent", CONFIG_FILE), "{broken");
    await expect(loadConfig({ ...dir, env: {} })).rejects.toThrow(ConfigError);
  });

  it("loadConfig：prices 为独立对象，改动不影响 DEFAULT_CONFIG", async () => {
    const dir = makeDirs();
    const config = await loadConfig({ ...dir, env: {} });
    config.prices.inputPerMillion = 999;
    config.prices.models!["deepseek-v4-pro"].outputPerMillion = 999;
    expect(DEFAULT_CONFIG.prices.inputPerMillion).toBe(1);
    expect(DEFAULT_CONFIG.prices.models?.["deepseek-v4-pro"]?.outputPerMillion).toBe(6);
  });
});

describe("prices 配置", () => {
  it("parseConfigFile：部分价格 + peak 解析", () => {
    const shape = parseConfigFile(
      JSON.stringify({
        prices: {
          inputPerMillion: 3,
          peak: { multiplier: 2, hours: [["09:00", "12:00"], ["14:00", "18:00"]] },
        },
      }),
      "test.json",
    );
    expect(shape.prices).toEqual({
      inputPerMillion: 3,
      peak: { multiplier: 2, hours: [["09:00", "12:00"], ["14:00", "18:00"]] },
    });
  });

  it("parseConfigFile：prices 非法值抛 ConfigError", () => {
    const bad = (prices: unknown) => parseConfigFile(JSON.stringify({ prices }), "f.json");
    expect(() => bad(-1)).toThrow(ConfigError);
    expect(() => bad({ inputPerMillion: 0 })).toThrow(ConfigError);
    expect(() => bad({ inputPerMillion: "1" })).toThrow(ConfigError);
    expect(() => bad({ peak: { multiplier: 2, hours: [] } })).toThrow(ConfigError);
    expect(() => bad({ peak: { multiplier: 2, hours: [["9:00", "12:00"]] } })).toThrow(ConfigError);
    expect(() => bad({ peak: { multiplier: 2, hours: [["25:00", "26:00"]] } })).toThrow(ConfigError);
    expect(() => bad({ peak: { multiplier: 2, hours: [["12:00", "09:00"]] } })).toThrow(ConfigError);
    expect(() => bad({ peak: { multiplier: 0, hours: [["09:00", "12:00"]] } })).toThrow(ConfigError);
    expect(() => bad({ peak: { multiplier: 2, hours: "09:00" } })).toThrow(ConfigError);
  });

  it("loadConfig：默认价格为官方平峰价（含 v4-pro 覆盖表）", async () => {
    const dir = makeDirs();
    const config = await loadConfig({ ...dir, env: {} });
    expect(config.prices).toEqual({
      inputPerMillion: 1,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 2,
      models: { "deepseek-v4-pro": { inputPerMillion: 3, cachedInputPerMillion: 0.025, outputPerMillion: 6 } },
    });
  });

  it("loadConfig：文件部分配置合并不丢默认", async () => {
    const dir = makeDirs();
    writeProject(dir, { prices: { inputPerMillion: 5 } });
    const config = await loadConfig({ ...dir, env: {} });
    expect(config.prices.inputPerMillion).toBe(5);
    expect(config.prices.cachedInputPerMillion).toBe(0.02); // 默认保留
    expect(config.prices.outputPerMillion).toBe(2);
    expect(config.prices.peak).toBeUndefined();
  });

  it("loadConfig：文件 peak 生效，env 单价覆盖文件", async () => {
    const dir = makeDirs();
    writeProject(dir, { prices: { inputPerMillion: 5, peak: { multiplier: 3, hours: [["10:00", "11:00"]] } } });
    const config = await loadConfig({ ...dir, env: { DEEPSEEK_PRICE_INPUT: "2.5" } });
    expect(config.prices.inputPerMillion).toBe(2.5);
    expect(config.prices.peak).toEqual({ multiplier: 3, hours: [["10:00", "11:00"]] });
  });

  it("loadConfig：env 非法价格抛 ConfigError", async () => {
    const dir = makeDirs();
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_PRICE_INPUT: "abc" } })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_PRICE_OUTPUT: "-1" } })).rejects.toThrow(ConfigError);
  });
});

describe("model 与 prices.models", () => {
  it("parseConfigFile：model 非空字符串校验", () => {
    expect(parseConfigFile(JSON.stringify({ model: "deepseek-v4-pro" }), "t.json").model).toBe("deepseek-v4-pro");
    expect(() => parseConfigFile(JSON.stringify({ model: "" }), "t.json")).toThrow(ConfigError);
    expect(() => parseConfigFile(JSON.stringify({ model: 123 }), "t.json")).toThrow(ConfigError);
  });

  it("parseConfigFile：prices.models 解析（部分覆盖 + peak）", () => {
    const shape = parseConfigFile(
      JSON.stringify({ prices: { models: { "deepseek-v4-pro": { outputPerMillion: 6, peak: { multiplier: 2, hours: [["09:00", "12:00"]] } } } } }),
      "t.json",
    );
    expect(shape.prices?.models?.["deepseek-v4-pro"]).toEqual({
      outputPerMillion: 6,
      peak: { multiplier: 2, hours: [["09:00", "12:00"]] },
    });
  });

  it("parseConfigFile：prices.models 非法值抛 ConfigError", () => {
    const bad = (models: unknown) => parseConfigFile(JSON.stringify({ prices: { models } }), "f.json");
    expect(() => bad({ "": { outputPerMillion: 6 } })).toThrow(ConfigError);
    expect(() => bad({ m: { outputPerMillion: -1 } })).toThrow(ConfigError);
    expect(() => bad({ m: { models: { x: {} } } })).toThrow(ConfigError); // 嵌套禁止
    expect(() => bad("not-an-object")).toThrow(ConfigError);
  });

  it("loadConfig：默认 model 为 flash，models 预置 v4-pro 官方价", async () => {
    const dir = makeDirs();
    const config = await loadConfig({ ...dir, env: {} });
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.prices.models?.["deepseek-v4-pro"]).toEqual({
      inputPerMillion: 3,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 6,
    });
  });

  it("loadConfig：env DEEPSEEK_MODEL 覆盖；文件 models 整块替换默认表", async () => {
    const dir = makeDirs();
    writeProject(dir, { prices: { models: { "custom-model": { outputPerMillion: 9 } } } });
    const config = await loadConfig({ ...dir, env: { DEEPSEEK_MODEL: "custom-model" } });
    expect(config.model).toBe("custom-model");
    // 默认 pro 表被整块替换：只剩 custom-model
    expect(Object.keys(config.prices.models ?? {})).toEqual(["custom-model"]);
    expect(config.prices.models?.["custom-model"]).toEqual({ outputPerMillion: 9 });
  });

  it("loadConfig：env 空 DEEPSEEK_MODEL 抛 ConfigError", async () => {
    const dir = makeDirs();
    await expect(loadConfig({ ...dir, env: { DEEPSEEK_MODEL: "  " } })).rejects.toThrow(ConfigError);
  });

  it("parseConfigFile：per-model peak 同样校验 start < end", () => {
    const bad = () => parseConfigFile(
      JSON.stringify({
        prices: { models: { "deepseek-v4-pro": { peak: { multiplier: 2, hours: [["18:00", "09:00"]] } } } },
      }),
      "f.json",
    );
    expect(bad).toThrow(ConfigError);
    expect(bad).toThrow(/prices\.models\.deepseek-v4-pro\.peak\.hours/);
  });
});

describe("validateConfig", () => {
  it("apiKey 为空返回错误信息，非空返回 undefined", () => {
    expect(validateConfig({ apiKey: "", ...DEFAULT_CONFIG })).toMatch(/DEEPSEEK_API_KEY/);
    expect(validateConfig({ apiKey: "  ", ...DEFAULT_CONFIG })).toMatch(/DEEPSEEK_API_KEY/);
    expect(validateConfig({ apiKey: "sk-1", ...DEFAULT_CONFIG })).toBeUndefined();
  });
});

describe("parseConfigFile：TypeBox 校验", () => {
  it("配置中的 $schema 字段被校验并剥离（仅供编辑器关联）", () => {
    const shape = parseConfigFile(JSON.stringify({ $schema: "./schema.json", apiKey: "sk-1" }), "t.json");
    expect(shape.apiKey).toBe("sk-1");
    expect("$schema" in shape).toBe(false);
    // 编辑器专用字段也按 schema 校验类型，运行时不再静默忽略非法值
    expect(() => parseConfigFile(JSON.stringify({ $schema: 123 }), "f.json")).toThrow(ConfigError);
  });

  it("错误消息包含字段路径（instancePath 转点号）", () => {
    expect(() => parseConfigFile(JSON.stringify({ reasoningEffort: "ultra" }), "f.json")).toThrow(/Invalid reasoningEffort/);
    expect(() => parseConfigFile(JSON.stringify({ prices: { outputPerMillion: -1 } }), "f.json")).toThrow(/Invalid prices\.outputPerMillion/);
  });

  it("非法值消息与迁移前行为等价（逐条拒绝）", () => {
    const bad = (raw: unknown) => parseConfigFile(JSON.stringify(raw), "f.json");
    expect(() => bad({ apiKey: "" })).toThrow(ConfigError);
    expect(() => bad({ apiKey: 123 })).toThrow(ConfigError);
    expect(() => bad({ model: "  " })).toThrow(ConfigError);
    expect(() => bad({ model: 123 })).toThrow(ConfigError);
    expect(() => bad({ reasoningEffort: "ultra" })).toThrow(ConfigError);
    expect(() => bad({ maxOutputTokens: -1 })).toThrow(ConfigError);
    expect(() => bad({ maxOutputTokens: 1.5 })).toThrow(ConfigError);
    expect(() => bad({ unknownField: 1 })).toThrow(ConfigError);
    expect(() => bad({ prices: -1 })).toThrow(ConfigError);
    expect(() => bad({ prices: { inputPerMillion: 0 } })).toThrow(ConfigError);
    expect(() => bad({ prices: { inputPerMillion: "1" } })).toThrow(ConfigError);
    expect(() => bad({ prices: { peak: { multiplier: 2, hours: [] } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { peak: { multiplier: 2, hours: [["9:00", "12:00"]] } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { peak: { multiplier: 2, hours: [["25:00", "26:00"]] } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { peak: { multiplier: 2, hours: [["12:00", "09:00"]] } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { peak: { multiplier: 0, hours: [["09:00", "12:00"]] } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { models: { m: { outputPerMillion: -1 } } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { models: { m: { models: { x: {} } } } } })).toThrow(ConfigError);
    expect(() => bad({ prices: { models: { "": { outputPerMillion: 6 } } } })).toThrow(ConfigError);
  });

  it("合法配置通过（含 prices.models 与 peak）", () => {
    const shape = parseConfigFile(
      JSON.stringify({
        apiKey: "sk-1",
        model: "deepseek-v4-pro",
        prices: {
          inputPerMillion: 3,
          peak: { multiplier: 2, hours: [["09:00", "12:00"], ["14:00", "18:00"]] },
          models: { "deepseek-v4-pro": { outputPerMillion: 6 } },
        },
      }),
      "t.json",
    );
    expect(shape.model).toBe("deepseek-v4-pro");
    expect(shape.prices?.peak?.hours).toEqual([["09:00", "12:00"], ["14:00", "18:00"]]);
  });
});

describe("schema 生成一致性", () => {
  it("生成文档与已提交的 zh/en 两份文件一致（防漂移）", async () => {
    const readFile = await import("node:fs/promises").then(m => m.readFile);
    const zh: unknown = JSON.parse(await readFile(join(process.cwd(), "schema", "deepseek-web-search.config.schema.zh.json"), "utf8"));
    const en: unknown = JSON.parse(await readFile(join(process.cwd(), "schema", "deepseek-web-search.config.schema.en.json"), "utf8"));
    expect(zh).toEqual(buildSchemaDoc("zh"));
    expect(en).toEqual(buildSchemaDoc("en"));
  });

  it("生成的 schema 允许并定义 $schema 字段（编辑器不告警）", () => {
    const en = buildSchemaDoc("en") as { properties: Record<string, { type?: unknown }> };
    const zh = buildSchemaDoc("zh") as { properties: Record<string, { type?: unknown }> };
    expect(en.properties.$schema?.type).toBe("string");
    expect(zh.properties.$schema?.type).toBe("string");
  });

  it("schema default 与 DEFAULT_CONFIG 对齐（单一来源抽查）", () => {
    const schema = JSON.parse(JSON.stringify(configFileSchema)) as {
      properties: Record<string, { default?: unknown; properties?: Record<string, { default?: unknown }> }>;
    };
    expect(schema.properties.model.default).toBe(DEFAULT_CONFIG.model);
    expect(schema.properties.maxOutputTokens.default).toBe(DEFAULT_CONFIG.maxOutputTokens);
    expect(schema.properties.timeoutMs.default).toBe(DEFAULT_CONFIG.timeoutMs);
    expect(schema.properties.cacheTtlMs.default).toBe(DEFAULT_CONFIG.cacheTtlMs);
    expect(schema.properties.maxResultChars.default).toBe(DEFAULT_CONFIG.maxResultChars);
    expect(schema.properties.baseUrl.default).toBe(DEFAULT_CONFIG.baseUrl);
    expect(schema.properties.reasoningEffort.default).toBe(DEFAULT_CONFIG.reasoningEffort);
    const prices = schema.properties.prices;
    expect(prices.properties?.inputPerMillion.default).toBe(DEFAULT_CONFIG.prices.inputPerMillion);
    expect(prices.properties?.cachedInputPerMillion.default).toBe(DEFAULT_CONFIG.prices.cachedInputPerMillion);
    expect(prices.properties?.outputPerMillion.default).toBe(DEFAULT_CONFIG.prices.outputPerMillion);
  });
});

describe("ConfigProvider", () => {
  it("get 缓存结果，reload 重新读取", async () => {
    const dir = makeDirs();
    const provider = new ConfigProvider({ ...dir, env: {} });
    const first = await provider.get();
    expect(first.apiKey).toBe("");

    // 直接修改文件后，get 仍返回缓存值
    writeGlobal(dir, { apiKey: "sk-new" });
    const cached = await provider.get();
    expect(cached.apiKey).toBe("");

    // reload 后读到新值
    const reloaded = await provider.reload();
    expect(reloaded.apiKey).toBe("sk-new");
  });
});
