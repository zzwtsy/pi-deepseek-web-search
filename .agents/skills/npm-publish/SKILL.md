---
name: npm-publish
description: 用户要求发布 npm 包新版本时使用——完整流程覆盖版本号 bump、本地验证、打 tag 推送触发 CI（OIDC Trusted Publishing 自动 npm publish）、发布验证与 GitHub Release 创建。触发场景：“发布 npm 包” / “发版” / “打 tag 发布” / “publish to npm”。仅创建 GitHub Release 时不要用本 skill，请使用 github-release。含常见失败（404 无权限、E422 provenance 校验、旧 workflow rerun）排查步骤。
license: MIT
compatibility: Requires git, gh (authenticated), pnpm/npm, and npm OIDC Trusted Publisher configured for the package
metadata:
  author: zzwtsy
  category: release
---

# npm 包发布流程

> ⚠️ **硬性规则:最终发布前必须确认**
> 执行推送 tag(触发 CI `npm publish`)与 `gh release create` 前,**必须向操作者
> 明确确认**(展示版本/tag、影响与准备情况,等待"确认发布"/"yes")。未获确认不得执行。
> 具体确认清单见下方「4. 操作者确认(必须)」与「8. 创建 GitHub Release」。

基于 OIDC Trusted Publishing(2025-12 起 npm classic token 已吊销,此为官方推荐路径)。

## 何时使用

- 用户要求发布新版本到 npm(发版 / release / publish)
- 版本号已改但未发布,需要走完 提交 → tag → push → 发布 → Release 全流程

### 何时不使用

- 仅修改文档/README,不发布新版本(不需要 bump 版本号)
- 仅创建 GitHub Release(npm 已发布)——改用 `github-release` skill
- 发布到私有 registry 或需要手动 `npm publish` 的场景(本流程依赖 OIDC CI 发布)

## 前置条件(首次配置,一次性)

1. **npm 包已存在**(首次发布需先手动 publish 一次);
2. **Trusted Publisher 已配置**:npmjs.com → 包 Settings → Trusted publishing → GitHub Actions,填写 owner/repo/workflow 文件名(大小写敏感);
3. **工作流已就绪**:`.github/workflows/publish.yml` 需包含:
   - `permissions: id-token: write`
   - `npm install -g npm@latest`(OIDC 需要 npm ≥ 11.5.1)
   - `npm publish --provenance --access public`
   - **不要设置 `NODE_AUTH_TOKEN`**(空 token 会遮蔽 OIDC 认证);
4. **package.json 含 `repository` 字段**(sigstore provenance 校验必需,缺失会 E422);
5. 本机安装 `gh` 并已认证(`gh auth status`),用于创建 GitHub Release。

## 发布流程

### 1. 确认版本号

- 检查 `package.json` 的 `version` 与最近提交性质是否匹配(semver 0.x 惯例:新功能升 minor,纯修复升 patch);
- 若版本号未改:先修改 → 提交 `chore: bump version to X.Y.Z`。

### 2. 本地验证(必须全绿才发布)

```bash
pnpm check && pnpm lint && pnpm test
```

### 3. 提交版本号变更

```bash
git add package.json
git commit -m "chore: bump version to X.Y.Z"
```

### 4. 操作者确认(必须)

**执行最终发布动作前,必须向操作者明确确认。** 展示以下信息并等待明确同意(如"确认发布" / "yes"),未获确认不得继续:

- 版本号:`X.Y.Z`(tag `vX.Y.Z`);
- 影响:推送 tag 将触发 CI(`publish.yml`)自动 `npm publish` 到 registry,不可撤销;
- 已完成的准备:本地验证全绿、版本号已提交。

确认后才执行第 5 步。

### 5. 打 tag 并推送(触发 CI 发布)

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

> **注意**:若之前打过的同版本 tag 发布失败,**必须删 tag 重建**(rerun 旧 run 会使用旧版 workflow,不会带上修复):
> ```bash
> git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
> git tag vX.Y.Z && git push origin vX.Y.Z
> ```

### 6. 监控 CI

```bash
# 等待 60-90 秒后查询
gh run list --workflow=publish.yml --limit 1
gh run view <RUN_ID> --log-failed   # 失败时查看具体错误
```

### 7. 验证发布结果

```bash
# npm registry 的 latest 应为新版本
npm view <包名> dist-tags.latest
# provenance 证明(应输出 slsa.dev/provenance/v1)
npm view <包名> dist.attestations
```

成功标志:registry latest 更新 + 包页面出现绿色 Provenance 徽章。

### 8. 创建 GitHub Release(需再次确认)

**创建 Release 同样属于对外发布动作,执行前需再次向操作者确认**(确认创建 vX.Y.Z 的 GitHub Release)。确认后:

```bash
# 生成变更日志(v 上一个 tag 以来的提交,按 feat/fix/refactor 归类)
git log <上一个tag>..vX.Y.Z --oneline
# 写入 /tmp/release-notes.md(含 Features / Fixes / Refactor / Install 小节)
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/release-notes.md
```

## 故障排查

| 症状 | 原因 | 修复 |
| --- | --- | --- |
| `404 Not Found - PUT registry.npmjs.org/<pkg>` | 无有效认证(匿名)或 Trusted Publisher 未配置/字段拼错(大小写敏感) | 配置 npmjs.com Trusted Publishing;检查 owner/repo/workflow 文件名 |
| `ENEEDAUTH` | npm < 11.5.1 或 workflow 缺 `id-token: write` | 加 `npm install -g npm@latest`;补 permissions |
| `E422 ... Failed to validate repository information: "repository.url" is ""` | package.json 缺 `repository` 字段 | 补充 `"repository": { "type": "git", "url": "https://github.com/<owner>/<repo>" }` 后重建 tag |
| 401/认证被跳过 | workflow 设置了空的 `NODE_AUTH_TOKEN` | 移除 NODE_AUTH_TOKEN env(空 token 遮蔽 OIDC) |
| 发布成功但 rerun 仍失败 | rerun 旧 run 使用旧版 workflow | 删 tag 重建后重新 push |
| classic token 相关错误 | 2025-12-09 起 classic token 已全部吊销 | 改走 OIDC Trusted Publishing,不要生成 Automation token |

## 本项目示例(pi-deepseek-web-search)

- 包名:`pi-deepseek-web-search`;仓库:`github.com/zzwtsy/pi-deepseek-web-search`(发布前以 `git remote -v` 确认为准);
- Trusted Publisher 需在 npmjs.com 配置(owner=`zzwtsy`,repo=`pi-deepseek-web-search`,workflow=`publish.yml`);
- 发布命令:`pi install npm:pi-deepseek-web-search` 安装;
- 本地开发测试(避免与已安装版工具名冲突):`pi -ne -e ./src/index.ts`。
