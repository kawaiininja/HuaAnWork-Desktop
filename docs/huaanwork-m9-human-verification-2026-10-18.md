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

**结果**:[x] 通过 / [ ] 不通过 / [ ] 阻塞 —— 证据:

- 启动方式(等价于 `dev:huaanwork` 内层,绕过已知会失败的 `market:prepare` 前缀):`DEEPSEEK_API_KEY=sk-invalid-for-m9-test node dsh-plugin-huaanwork/lib/bin.js`,启动日志 `/tmp/m9-step1-dev3.log`。
- stored 凭据 = `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 的 `api_key`(`sk-961c…`,smoke 账户登录态有效)。
- **正向**:stored 在位 + 错误 env key → 发送「ping:m9 凭据核对,请回复 ok」→ 模型正常回复「ok」(截图 `/tmp/m9-screen3.png`,会话「凭据核对请求回复确认」)⇒ stored 胜出。
- **反证(可选步已执行)**:quit → 备份并移除 settings 中全部 `api_key` 字段 → 同一错误 env key 重启 → 发送「ping:m9 反证,请回复 ok」→ **HTTP 401 Authentication Fails (governor)**,会话标记失败(截图 `/tmp/m9-screen7.png`)⇒ 无 stored 时回落到 env 并被拒。随后 settings 已从 `/tmp/m9-settings-backup.json` 逐字节恢复(`api_key` 在位复核 ✓)。
- 结论:stored > env 双向成立,与 credentials README §"A stored key outranks the launching environment" 一致。

**过程发现(缺陷,已修复并提交)**:首次启动即撞 rc.1 渲染启动阻断 —— `RendererStartupFailure: Renderer boot failed for 3 plugin(s)`(`dsh-client-ui-skill` / `dsh-client-ui-reference` / `dsh-client-ui-secret-mask`),稳定复现、直接进恢复模式。根因:rc.1 给这三个客户端插件的 `inject` 新增 `uiConversation` 硬依赖(alpha.1 无此依赖;对 vendored rc.1 全部 48 个 client-ui 插件的 inject 扫描确认新增依赖且不在既有禁用清单中的恰好是这三个),而 huaanwork advanced 模式按 M3 设计禁用 `ui-conversation` 行。修复:`profile.ts` advanced 禁用清单补 `ui-skill`/`ui-reference`/`ui-secret-mask` 三行 + `verify-profile-boot.mjs` 断言清单与 `profile.spec.ts` 两处钉同步(提交 `61cfc3383f`;`verify:profile` EXIT=0、profile.spec 57/57、typecheck EXIT=0 复测全绿)。无头链未拦住的原因是 verify:profile 走 minimal preset 不进 advanced Web 图——已在断言清单补上这三包,同类回归未来会被无头链拦下。

### Step 2:市场重复安装 → `already-installed` 报错语义

**预期**(rc.1 plugin-manager):对已安装的包再次 `installBundle` 返回 `application: 'failed'` + `error.code: 'already-installed'`,不修改任何 profile 文件;`removeBundle` 后同一安装返回 `applied` 与新版本。市场 UI 文案为 “This plugin is already managed by the active profile.”。

**步骤(人机)**:
1. 在市场安装一个插件(记录包名/版本)。
2. 对同一插件再次点击安装:应出现 already-installed 语义的失败提示,而不是二次安装或崩溃。
3. 记录安装前后的 profile `package.json`/`pnpm-lock.yaml` 未被重复安装改动。
4. 可选:移除后再安装,确认返回 applied。

**结果**:[x] 通过(带判据订正,待裁定) / [ ] 不通过 / [ ] 阻塞 —— 证据:

**判据订正(结构性)**:`already-installed` 失败分支按升级指南与 rc.1 源码双重确认 **只在 HMR 运行的 profile 存在**(`plugin-manager/lib/index.js:1991` 以 `ctx.get("hmr") !== undefined` 为门;upgrade-guide:「未启用 HMR 时,在已安装的包上安装仍会运行 pnpm 并报告 restart-required」)。huaanwork guardrail 锁恒关 hmr 行(profile.ts:1531,组合中 hmr 服务不存在——探测变体翻开 disabled 补丁后 `ctx.get('hmr')` 仍为 undefined,即守卫是移除插件本体而非仅关行)⇒ **该失败分支在本变体结构性不可达**。计划引用的 UI 文案 "This plugin is already managed by the active profile." 实测位于 `dsh-community-market/src/install/service.ts:353,703`(社区市场面),非 huaanwork 内网市场 UI。

**真机实测(2026-10-18,三层)**:
1. **市场 UI 层(真机 UI)**:loopback market-server(release 钥匙 `~/.huaanwork-release/` 签名,revision 1,条目 m4-fixture-plugin@0.1.0)+ `HUAANWORK_MARKET_ORIGIN=http://127.0.0.1:8789` 启动 dev。「可安装」页签对已安装项渲染 **disabled「已安装」按钮**(`MarketView` 的 `installButtonState`:`item.installed ⇒ disabled`),点击无任何动作——重复安装在 UI 层被预防,不可触发(截图 `/tmp/m9-screen13.png`)。
2. **底层语义(真机无头探测,同一 huaanwork profile 组合)**:`installBundle(tgz)` ×2 → removeBundle → installBundle,实测序列:
   - install#1: `restart-required`, changed=true
   - **install#2(重复): `restart-required`, changed=false, restartReason=`no-hmr`,且 profile `package.json`/`pnpm-lock.yaml` sha256 逐字节不变** ✓(与 rc.1 无-HMR 文档语义逐字一致;「不修改任何 profile 文件」成立)
   - removeBundle: `restart-required`, changed=true
   - install#3(移除后): `restart-required`, changed=true, version=0.1.0 ✓(「removeBundle 后同一安装返回成功与新版本」成立;无 HMR 下成功档为 restart-required 而非 applied)
3. **附带观察(登记,非本步判据)**:m4-fixture-plugin 的旧式 `dsh.bundle: true` 声明被 rc.1 校验拒(`dsh.bundle.patch must be a file path or a list of file paths`)——它只能经内网市场路径(裸 `pnpm add`,不做 bundle 校验)进入 profile,installBundle 路径进不去;对已装 m4-fixture 无运行影响(未被选为 bundle 行)。

### Step 3:迁移幂等 × rc.1 persistence 新增 7 项

**预期**:在已有旧树/已迁移树上重复启动,迁移跳过已存在项、不破坏 rc.1 新格式;每次启动的迁移日志不导致数据丢失。

**步骤(人机)**:
1. 使用已有 `~/.huaanwork`(含 M4 迁移态)启动应用两次。
2. 记录两次启动的迁移日志:第二次应跳过既有项,不重复搬迁、不覆盖。
3. 逐条确认以下 7 个 rc.1 persistence 变更不被迁移破坏(启动、读写、重启后仍正常):

| # | persistence 变更 | 结论 | 证据 |
|---|---|---|---|
| 1 | `2026-09-13-working-directory` | [x] 通过 | 今日 rc.1 会话 `huaanwork-21ea5abce4b51784` 的 `session` 记录带 `cwd`(`/Users/amonmiao/.huaanwork/profiles/desktop/workspace`);10-15 旧会话(无 cwd 快照行)在 UI 打开渲染正常、零报错横幅(截图 `/tmp/m9-step3-old-session.png`) |
| 2 | `2026-09-19-external-subagent-catalog` | [x] 通过(无可迁移数据面) | 全树无任何 subagent catalog 数据(`find ~/.huaanwork -name "*catalog*" -o -name "*subagent*"` 零命中,智能体目录为空=A8 基线);变更为 additive(v0/v1 记录保持有效),空目录无可破坏面 |
| 3 | `2026-09-30-job-session-lifecycle` | [x] 通过(触发面结构性关闭) | jobs 行被 guardrail 锁禁用 ⇒ 新 job 事件种类不可触达;变更为「只增事件种类、不动 Session 信封」,历史会话不伪造 job 历史;旧会话(10-15/10-16)读取渲染全部正常 |
| 4 | `2026-10-05-ptc-operation-metadata` | [x] 通过(触发面结构性关闭) | `tools.presentAs("ptc")` 被 HuaAnWork 禁用(今日 host 日志该错误行实际触发,锁在生效)⇒ 带 meta 的 ptc-dispatch 记录不可产生;`meta` 为可选 JsonValue 字段,既有记录保持有效 |
| 5 | `2026-10-05-working-directory-attribution` | [x] 通过 | 今日会话的 runtime-context user/message(cwd 通知)携带 `source.kind: "user"` 正常写入与回读;attribution 为 additive source 种类,旧策略对未知归因保持不解释 |
| 6 | `2026-10-07-title-reasoning-effort` | [x] 通过 | 今日会话产生完整 `session/title-llm-request` + `session/title`(provider 生成的标题「凭据核对请求回复确认」);`reasoningEffort` 为可选字段,当前路由(deepseek-official/local)不暴露可选 reasoning ⇒ 缺省合法(文档:「Existing V4 records remain valid and retain their original absence」) |
| 7 | `2026-10-13-user-rpc-principal` | [x] 通过 | 今日两条 user/message 的 `source` = `{"kind":"user"}` 无 principal——owner 提交按文档缺省(「Owner prompts omit the field」);旧阅读器语义不受影响(SESSION_FORMAT_VERSION 未升) |

**结果**:[x] 通过 / [ ] 不通过 / [ ] 阻塞 —— 证据:

- **迁移幂等(三次启动)**:launch 1/2/3 的迁移日志完全一致(「跳过 3 项(已存在或不可解析)」,不重复搬迁、不覆盖),`huaanwork-migration.json` 标记文件 sha256 跨启动逐字节不变(`/tmp/m9-step3-marker-{1,2}.txt` diff 为空)。已知文案观察项 F-M4-4(「需要重新登录一次」误导文案)仍每启动打印,维持 M4 登记口径。
- **写→重启→读往返**:rc.1 写入的今日会话在 launch 3(重启后)UI 重开正常(AX 文本含两条 ping 与模型「ok」回复)。
- 7 项逐条见上表;其中 #2/#3/#4 的正向触发面在本变体不存在(空目录/jobs 锁/ptc 锁),结论依据 = 幂等证据 + 兼容性条款 + 旧数据读取证据,未声称触达这些格式的写入路径。

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
