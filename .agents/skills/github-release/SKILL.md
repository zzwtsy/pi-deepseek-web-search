---
name: github-release
description: 用户要求创建 GitHub Release 时使用——确认版本基线、按类型生成变更日志、编写中英双语 release notes（必须同时提供英文与中文两个版本）、gh release create 发布与验证。触发场景：“创建 GitHub Release” / “发布 release” / “写 release notes” / “生成版本发布说明”。仅发布到 npm 时不要用本 skill，请使用 npm-publish。
license: MIT
compatibility: Requires gh CLI (authenticated) and an existing git tag
metadata:
  author: zzwtsy
  category: release
---

# GitHub Release 创建流程

> ⚠️ **硬性规则:最终发布前必须确认**
> 执行 `gh release create`(最终发布动作)前,**必须向操作者明确确认**
> (展示目标 tag、影响与 notes 预览,等待"确认发布"/"yes")。未获确认不得执行。
> 具体确认清单见下方「4. 操作者确认(必须)」。

## 何时使用

- 用户要求创建/发布 GitHub Release(通常发生在 npm 发布成功后);
- 已有 tag(如 `v0.3.0`)但未创建 Release;
- 需要生成双语(中英)release notes。

### 何时不使用

- 仅发布到 npm(Release 由 npm-publish 流程顺带创建)——改用 `npm-publish` skill
- 需要 draft / prerelease 的发布(本流程创建正式 Release)
- 目标 tag 不存在且用户未要求打 tag(先确认打 tag 或改用 npm-publish 全流程)

## 前置条件

1. `gh` 已安装并认证(`gh auth status`);
2. 目标 tag 已存在(`git tag -l` 确认);若不存在,先按发布流程打 tag;
3. 确定基线:上一个 tag(`git tag --sort=-v:refname | head -3`),用于生成变更日志。

## 流程

### 1. 确认版本与基线

```bash
git tag -l                          # 查看已有 tag
git log <上一个tag>..<新tag> --oneline   # 本次变更的提交列表
```

### 2. 按类型归类变更日志

阅读提交列表,按语义归类(feat → 功能、fix → 修复、refactor/chore/ci/docs → 重构/工程):

- **✨ Features** —— 新功能、行为增强
- **🔧 Fixes** —— bug 修复
- **🏗 Refactor** —— 重构、类型整理、文档、CI 变更
- **📦 Install** —— 安装命令(如 `pi install npm:<包名>`)

### 3. 编写中英双语 release notes

**必须同时包含英文与中文两个版本**,结构与措辞对应一致。写入临时文件:

````bash
cat > /tmp/release-notes.md << 'EOF'
# vX.Y.Z

## English

### ✨ Features

- ...

### 🔧 Fixes

- ...

### 🏗 Refactor

- ...

### 📦 Install

```bash
pi install npm:<包名>
```

## 中文

### ✨ 新功能

- ...(与英文 Features 逐条对应)

### 🔧 修复

- ...(与英文 Fixes 逐条对应)

### 🏗 重构

- ...(与英文 Refactor 逐条对应)

### 📦 安装

```bash
pi install npm:<包名>
```
EOF
````

双语对应原则:
- 两个版本的小节**一一对应**(同一条目在两个语言版本中都出现);
- 条目保持动词开头、简洁(英文:过去式/名词短语;中文:动宾短语);
- 技术名词(参数名、错误码、命令)不翻译;
- 开头可加一句概述(英文 1 句 + 中文 1 句)。

### 4. 操作者确认(必须)

**执行最终发布动作前,必须向操作者明确确认。** 展示以下信息并等待明确同意(如"确认发布" / "yes"),未获确认不得继续:

- 目标 tag:`vX.Y.Z`;
- 影响:创建后将公开可见(非 draft),不可撤销;
- notes 预览:双语 release notes 的标题与摘要(各小节条目数)。

确认后才执行第 5 步。

### 5. 创建 Release

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/release-notes.md
```

### 6. 验证

```bash
gh release view vX.Y.Z    # 确认标题/tag/notes 已发布,非 draft
```

## 注意事项

- 若 Release 已存在(如发布失败重试),需先删除:`gh release delete vX.Y.Z`(或加 `--edit` 更新);
- tag 不存在时先创建:`git tag vX.Y.Z && git push origin vX.Y.Z`;
- notes 中的 Markdown 代码块(安装命令)注意 heredoc 内的转义。

## 本项目示例(pi-deepseek-web-search)

- 仓库:`github.com/zzwtsy/pi-deepseek-web-search`(发布前以 `git remote -v` 确认为准)
- 上次基线:`v0.1.0`(首个 Release 时);之后用最近 tag
- 安装命令:`pi install npm:pi-deepseek-web-search`
- 双语 notes 开头概述示例:
  - EN: `DeepSeek web search extension for pi — published via OIDC Trusted Publishing with SLSA provenance.`
  - ZH: `pi 的 DeepSeek 联网搜索扩展——通过 OIDC Trusted Publishing 发布,带 SLSA provenance 证明。`
