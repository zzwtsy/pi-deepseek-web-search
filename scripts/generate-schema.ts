// 生成脚本：从 src/config-schema.ts 的单一来源生成中/英两份 JSON Schema。
// 用法：pnpm gen:schema（Node 26 原生 TS 运行，无需构建）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchemaDoc } from "../src/config-schema.ts";

const OUT_DIR = fileURLToPath(new URL("../schema/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

for (const lang of ["zh", "en"] as const) {
  const doc = buildSchemaDoc(lang);
  const file = join(OUT_DIR, `deepseek-web-search.config.schema.${lang}.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`generated: ${file}`);
}
