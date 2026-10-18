# 2026-10 M9 真机核对记录(Task 14 + Task 15)

> 工件性质:M9-C 人类核对记录(2026-10-18 开档,Task 15 继续写)
> Worktree:`HuaAnWork-Desktop-sync-m9`(分支 `sync/upstream-2.1.x`,基点 `2edce24e4f`,复核提交 `6af7bf5c9c`)
> 前置:`docs/evidence/2026-10-m9-task13-remediation.md`(无头链全绿);本文件只记真机结论与证据。
> 判据来源:`docs/superpowers/plans/2026-10-17-m9-upstream-sync.md` Task 14/15;行为依据 `deepseek-harness/packages/credentials/credentials/README.md` §"A stored key outranks the launching environment" 与 `deepseek-harness/docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed/guide.zh.md`。

## Task 14:四项真机冒烟

### Step 4:`verify:profile` 断言与 guardrails 锁 —— ✅ 通过(无头,2026-10-18)

命令:`corepack yarn workspace dsh-plugin-huaanwork run verify:profile`
退出码:0
关键输出:`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`
说明:输出中 `web-fetch-http`(等待 `web`)与 `job-controller`(等待 `jobs`)两条 pending 是 huaanwork guardrails 锁的预期结果,不是失败。

### Step 1:登录凭据优先级反转(stored > env)

**预期**:stored 凭据存在时,启动环境里的 `DEEPSEEK_API_KEY` 不生效;取消 stored 后才回落到环境变量。

**步骤(人机)**:
1. 应用内完成登录/保存 API key(确保 stored 记录存在)。
2. 关闭应用;在终端用**错误的**环境 key 启动:
   ```bash
   DEEPSEEK_API_KEY=sk-invalid-for-m9-test corepack yarn dev:huaanwork
   ```
   (或对已安装制品设置同名环境变量启动。)
3. 发一条消息:应当正常成功 ⇒ stored 胜出。若报鉴权失败 ⇒ env 胜出,判不通过。
4. 可选反证:清除 stored key 后重复步骤 2,应当按 env 的 `sk-invalid-for-m9-test` 失败。

**结果**:[ ] 通过 / [ ] 不通过 / [ ] 阻塞 —— 证据:

### Step 2:市场重复安装 → `already-installed` 报错语义

**预期**(rc.1 plugin-manager):对已安装的包再次 `installBundle` 返回 `application: 'failed'` + `error.code: 'already-installed'`,不修改任何 profile 文件;`removeBundle` 后同一安装返回 `applied` 与新版本。市场 UI 文案为 “This plugin is already managed by the active profile.”。

**步骤(人机)**:
1. 在市场安装一个插件(记录包名/版本)。
2. 对同一插件再次点击安装:应出现 already-installed 语义的失败提示,而不是二次安装或崩溃。
3. 记录安装前后的 profile `package.json`/`pnpm-lock.yaml` 未被重复安装改动。
4. 可选:移除后再安装,确认返回 applied。

**结果**:[ ] 通过 / [ ] 不通过 / [ ] 阻塞 —— 证据:

### Step 3:迁移幂等 × rc.1 persistence 新增 7 项

**预期**:在已有旧树/已迁移树上重复启动,迁移跳过已存在项、不破坏 rc.1 新格式;每次启动的迁移日志不导致数据丢失。

**步骤(人机)**:
1. 使用已有 `~/.huaanwork`(含 M4 迁移态)启动应用两次。
2. 记录两次启动的迁移日志:第二次应跳过既有项,不重复搬迁、不覆盖。
3. 逐条确认以下 7 个 rc.1 persistence 变更不被迁移破坏(启动、读写、重启后仍正常):

| # | persistence 变更 | 结论 | 证据 |
|---|---|---|---|
| 1 | `2026-09-13-working-directory` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |
| 2 | `2026-09-19-external-subagent-catalog` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |
| 3 | `2026-09-30-job-session-lifecycle` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |
| 4 | `2026-10-05-ptc-operation-metadata` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |
| 5 | `2026-10-05-working-directory-attribution` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |
| 6 | `2026-10-07-title-reasoning-effort` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |
| 7 | `2026-10-13-user-rpc-principal` | [ ] 通过 / [ ] 不通过 / [ ] 阻塞 | |

**结果**:[ ] 通过 / [ ] 不通过 / [ ] 阻塞 —— 证据:

## Task 15:新制品 + A1–A19 重跑

### Step 1:构建 macOS 制品

- [ ] `corepack yarn dist:mac:huaanwork` 成功;或按计划走 `market:prepare` 失败兜底链(不提交市场版本变动)。

### Step 2:A1–A19 全项重跑

2026-10-07 旧记录全部作废。按 `docs/huaanwork-m4-human-verification-2026-10-07.md` 的 A1–A19 逐项重跑,每项记「通过/不通过/阻塞 + 证据」。

| 项 | 结论 | 证据 |
|---|---|---|
| A1–A19 | (待填) | |

### Step 3:A10 单独裁决

托盘图标渲染仍不通过时单独决定能否发;结论写入 `AGENTS.md` 债表托盘行。R-M9-4:全程未先修 A10,收口记录写遵守声明。

**A10 裁决**:[ ] 通过 / [ ] 不通过仍发(理由:)/ [ ] 不通过挂起
