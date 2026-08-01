import antfu from "@antfu/eslint-config";

export default antfu({
  typescript: {
    tsconfigPath: "tsconfig.json",
  },
  stylistic: {
    indent: 2,
    semi: true,
    quotes: "double",
  },
  ignores: [
    "**/*.md",
    "**/.agents/**",
  ],
  rules: {
    "style/brace-style": ["error", "1tbs", { allowSingleLine: true }],
  },
}).append({
  files: ["tests/**"],
  rules: {
    "no-console": "off",
    // describe 是主题分组,常用类名/模块名(PascalCase)作标题;it 是行为描述,保持小写句子。
    "test/prefer-lowercase-title": ["error", { ignore: ["describe"] }],
  },
});
