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

- [x] `corepack yarn dist:mac:huaanwork`:**按计划走了 `market:prepare` 失败兜底链**。实测:dshmarket latest 已到 1.66.37,补丁 hunk #1 FAILED(计划登记的 1.66.32/1.66.35 在 hunk #7——版本继续漂移、失败点同型);manifest 与 lockfile 已自动还原,`git status` 无市场文件残留 ✓。兜底链逐项:`aa:prepare-release` ✓(复用已验证 AA 制品 r57f6b0fe)→ `huaanwork-verify-provisioning.mjs` ✓(三项钉扎指纹输出)→ `dsh-community-market build` ✓ → `dsh-plugin-huaanwork dist:mac` 停在「A valid Developer ID Application certificate ... required in the Keychain」= **R-6 预期终态**(无签名凭据,release 流水线拒绝降级)。
- **过程发现(合并残留缺陷,已修复并提交 `18a09c2b8a`)**:`dist:mac-smoke` 首跑失败「universal macOS runtime is missing 4 native file(s)」——rc.1 合并把 stable/beta 的 sharp 升到 0.35.5,而 huaanwork 的 `package.json` 钉与 `mac-universal.ts` 原生文件名清单滞留在 0.35.3/libvips 8.18.3,hoisting 把 0.35.5 的 @img 树放在被检查路径上。修法:对齐 beta(`sharp: 0.35.5` + 文件名 0.35.5/libvips 8.18.7,该段与 beta 逐字节一致);`yarn install` 后 `check:desktop-variants` 复测全绿(白名单 65/6 不变)。
- 制品:`dsh-plugin-huaanwork/dist/mac-smoke/`(dist:mac-smoke 通道,与 M4 核对同款免签名制品)。

### Step 2:A1–A19 全项重跑

制品:`dist/mac-smoke/mac-universal/HuaAnWork.app`(dmg sha256 `35f8d1d5390f…`,504,128,390 B;含托盘/渲染修复后的**第三次构建**——第二次构建覆盖了更新下载门修复,详见 A16)。环境:macOS 26(Darwin 27)+ Electron 44,刘海屏 3024×1964。**环境干预(如实登记)**:用户机器运行 iBar Pro(菜单栏管理器),托盘项相关核对其间退出两次、核对完成后已重启恢复。

| 项 | 结论 | 证据 |
|---|---|---|
| A1 设置页配置 | 通过(带事实订正) | 外观=跟随系统(渲染深色)、模型 deepseek/deepseek-flash @ https://api.deepseek.com、允许接入公网=开(「当前状态:可接入公网」)、guard_mode=高危才询问(F-M4-5 留置态)。与 settings.json 逐字一致;M4 记录的「深色/stub-model 端点」已被后续会话的真实配置取代,现值即基线。截图 `a1-settings.png`/`a1-appearance.png`/`a1-permissions.png` |
| A2 登录态与旧密码 | 通过(结构性同 M4) | 新制品启动直入主界面(auth-session 有效,smoke 账户在线);旧华安工作台密码正向在结构上不可达(同 M4 判定,目标账户是 smoke 而非旧树 Amon) |
| A3 项目列表 | 通过(带事实订正) | 侧栏项目 = 量化回测工具/项目管理平台等,与 `projects.json` 5 条逐一对应,全部来源可解释(本周真实使用产物;旧树迁移带入项目数=0 的 M4 结论不变) |
| A4 任务列表 | 通过(带事实订正) | 侧栏任务 = 公募基金行业信息采集(自动化运行)/查询上海一周天气预报(10-15)/询问助手可以做什么(10-16)/凭据核对请求回复确认(今日核对产物)等,全部来源可解释,无迁移残留脏数据 |
| A5 中性根会话 | 通过 | 磁盘:中性根 `huaanwork-21ea5abce4b51784` 树在位(cwd 逐字 `~/.huaanwork/profiles/desktop/workspace`);UI:10-15 旧会话打开渲染正常零报错横幅(`m9-step3-old-session.png`);今日 rc.1 会话重启后重开正常 |
| A6 自动化列表 | 通过(带事实订正) | 非空:2 条真实自动化(公募基金行业信息采集——10-15 22:13 成功运行记录;监管法规信息跟踪——从未运行),均为本周真实使用产物;视图渲染正常。`a6-automations.png` |
| A7 技能中心 | 通过 | 内置技能齐备(AX 树 25 处「内置」标记),`a7-skills.png` |
| A8 智能体目录 | 通过 | 发现/已启用/本地入口均空(暂无智能体);公用机目录(10.130.209.76:18080)不可达给出诚实失败横幅「请求失败:The operation was aborted due to timeout」——非迁移问题。`a8-agents.png` |
| A9 Dock 图标 | 通过 | Dock = 华安品牌蓝底白字标 + 运行指示点,非 Electron 默认。`a9-dock-crop.png` |
| A10 托盘图标 | **通过(归因环境干扰)**——详见 Step 3 | iBar Pro 退出后:图标正常渲染(华字标高亮态)+ 菜单全功能; iBar 在场:状态项 rect 零渲染(M4 同款现象复现)。A/B 双证据:`a10-tray-rendered.png` / `a10-ibar-back-blank.png` / `a10-tray-menu.png` |
| A11 安装器卷图标 | 通过 | `.VolumeIcon.icns` 与 `Contents/Resources/icon.icns` sha256 逐字节一致(`f5969529679e…`,与 M4 同一份品牌资产);卷窗口 app 图标 = 华安品牌。`a11-dmg-volume.png` |
| A12 市场来源面板 | 通过 | 来源页签渲染齐备:内网市场源(信任锚已配置,公钥 f34f6afe…)/禁用插件市场/华安内网市场(当前)/R-4 收窄文案。`a12-source-panel.png` |
| A13 原生目录选择器 | 通过 | 项目「+ 新建」触发系统原生 NSOpenPanel(Favorites/Locations/Tags 齐备)→ 选择目录 → 新建项目对话框(路径+名称预填)→ 取消(不改状态;完整切换链由 A14 的 relaunch 覆盖)。`a13-native-picker.png` / `a13-new-project-dialog.png` |
| A14 立即重启链 | 通过 | 切源(华安内网市场→禁用)→ 保存 → 原生确认「现在重启 HuaAnWork?」→ 取消 → 常备「立即重启」横幅常驻(「已选择…取消重启不会撤销该选择…」)→ 立即重启 → 再确认 → relaunch(pid 30914→31642)→ 禁用态诚实横幅(「插件市场未启用…」)→ 切回并 relaunch(→31812)市场恢复。`a14-persistent-banner.png` / `a14-market-disabled.png` |
| A15 托盘更新提示 | 通过 | loopback update-server(0.1.1,sha256=新 dmg)启动后 ~60s 后台检查触发,托盘菜单出现「HuaAnWork 0.1.1 可用」(中文 locale,品牌名 ✓)。`a15` 截图(裁片 `/tmp/m9-a15-crop.png`) |
| A16 确认与下载弹窗 | **通过(修复后;初跑发现并修复一个回归)** | 初跑:两次下载均被客户端中止,日志 `Error: The update download must settle on HTTPS.` ×2 —— 上游 #622(M8 进入)的下载门在调用方不传 origin 时默认仅 https,本变体生产 origin 是 http 内网 ⇒ 该路径全灭。修复:`electron-runtime.ts` 显式传 `resolveUpdateOrigin()`(commit `8b0218998b`,同域 http 放行、外域重定向仍拒;tests 159/159)。第三版制品重跑:确认框「HuaAnWork 0.1.1 已可用。现在下载此更新?」→ 保存对话框默认文件名 `HuaAnWork-0.1.1-mac.dmg`(位置:下载)✓。`/tmp/m9-a16-5-crop.png` / `/tmp/m9-a16d-crop.png` |
| A17 下载完成检查 | 通过(修复后制品) | `pending-installer.json` = `{"stateVersion":1,"platform":"darwin","version":"0.1.1","path":"~/Downloads/HuaAnWork-0.1.1-mac.dmg"}` ✓;xattr 无 `com.apple.quarantine`(仅 lastuseddate/macl/provenance)✓;下载件 sha256 `35f8d1d5…` 逐字符等于通道记录 ✓ |
| A18 无 origin 静默 | 通过(按 M4 裁定后措辞) | 独立启动(无 origin)→ 托盘「检查更新…」→ 设计内失败警示框「未能获取更新信息。请稍后重试。」(手动检查诚实反馈);无更新流程启动;`grep "dshdesktop" src/update-*.ts src/updates.ts` = 0 命中。`a18-update-failed-dialog.png` |
| A19 篡改负例 | 通过(含恢复复核) | 通道记录 sha256 首字符 3→9 → 客户端「0.1.1 可用」→ 下载 → 服务端确服务字节(download request 日志)→ **客户端零落盘**(~/Downloads 无 dmg、updates/ 无 pending-installer、无临时残留),UI 静默(设计内),客户端日志 `Error: The update installer does not match the published digest.`;恢复:通道记录 cmp 备份 IDENTICAL、端点复验回原 sha、完好 dmg 移回、pending-installer 逐字重写 ✓ |

**过程发现(追加)**:
1. **首次启动窗口加载偶发失败**:新制品第一次启动 `net::ERR_EMPTY_RESPONSE`、零窗口(无 renderer 失败、无恢复窗);退出重启后正常。疑似窗口加载与 webserver 就绪的竞争,登记为观察项(日志 `/tmp/m9-launch1.log`)。
2. **托盘 AXPress 返回码不稳定**:-25204(cannotComplete)与 0 交替出现,但菜单实际均可达(错误码不可靠);托盘项位置随菜单栏布局变动((877,4)/(532,4) 都出现过)。
3. **更新全链路文案已中文化**(M7 tray-locale 清扫的真机呈现):「HuaAnWork 0.1.1 可用」「已可用。现在下载此更新?」等。

### Step 3:A10 单独裁决

**A10 裁决**:[x] 通过(归因 iBar Pro 环境干扰)/ [ ] 不通过仍发(理由:)/ [ ] 不通过挂起

- **A/B 双证据(2026-10-18,同一 M9 制品、同一机器)**:iBar Pro 退出 → 状态项回落屏上((877,4)/(532,4),随菜单栏布局漂移)、**华字标正常渲染**、托盘菜单全功能(截图 `a10-tray-rendered.png` / `a10-tray-menu.png`);iBar Pro 在场 → 状态项被泊入屏外 (-1,986) 或屏上 rect **逐像素零渲染**——M4 的 F-M4-1 现象精确复现(`a10-ibar-back-blank.png`)。
- **裁决(用户,2026-10-18)**:A10 判**通过**;F-M4-1 由「应用渲染层缺陷」翻转为「iBar Pro 接管/隐藏导致的环境干扰」。应用侧(macOS 26 + Electron 44 + rc.1)无缺陷,上游与 fork 在 M4→M9 窗口对托盘零改动(上游 `git log 5badb15009..1600d8a1e14 -- *tray*` 零命中;`tray-icons.ts` 与 beta 逐字节一致)。
- **R-M9-4 遵守声明**:全程未先修 A10——托盘相关代码零改动,两个修复提交(61cfc3383f / 8b0218998b)均与托盘无关。
- 债表托盘行已在 `AGENTS.md` 收口为已关闭(环境归因);残留观察项(iBar 类管理器在场的可发现性)已登记在该行。
- 环境恢复:iBar Pro 已于核对结束后重启恢复。
