# 会话内创建智能体包 M2 实施代码评审整改清单

- **评审日期**：2026-10-25
- **评审分支**：`feat/agent-packages-m2`
- **评审基线**：`c411d12d891de6179e1c72d1afcab5995bbbe0b6`
- **评审 HEAD**：`1235f0bae24348ceed766b37e30524dab86816e7`
- **整改代码 HEAD**：`93c1bb029134aa79d26ce3cff3ba2d55e5aa5bf1`（Windows M2 绿跑所在提交）；其后的证据文档提交不改代码
- **需求依据**：`docs/superpowers/plans/2026-10-24-chat-created-agent-packages-m2.md`
- **整改依据**：`docs/superpowers/plans/2026-10-25-chat-created-agent-packages-m2-remediation.md`
- **范围裁定与最终门槛**：`docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md`
- **变更规模**：27 个提交，95 个文件，约 +26,359 / −753 行（评审时口径）
- **评审方式**：只读静态评审；按签名/包格式、服务端/CLI、桌面宿主、UI/验收四个面独立审查，主会话复核关键控制流、代码锚点与验收证据。未切换分支，未修改实现，未运行可能产生构建产物的测试。
- **行号口径**：本文所有源码和证据行号均以评审 HEAD `1235f0bae2` 为准；后续整改须重新校准行号，不得把旧行号当作现状证明。

## 一、结论与使用规则

**代码合并建议：With fixes（已完成）；M2 完成判定：COMPLETE WITH WAIVER（R-ACCEPT-1）。**

- **Critical：0 项**
- **Important：20 项**，合并前完成整改并通过对应回归验证。
- **Minor：7 项**，随相关模块整改；如裁定延后，必须记录原因、触发条件和责任人，不得静默视为已关闭。
- Task 13 的 HEAD 验收与 Windows 验收已完成；跨机器验收按 owner 裁定 **R-ACCEPT-1** 由 Windows GHA 替代（这是“豁免/替代”，不是“跨机器 PASS”），M2 可标记为 **complete with waiver**，残余风险见下。

**整改结果（2026-10-25，Task 14 汇总 + R-ACCEPT-1）**：I-1～I-19 已勾选并附整改提交与回归证据；
I-20 按裁定 R-M2-3 延后（不实现、不新增第 8 个 RPC）；M-1～M-7 已勾选。macOS 探针在最终代码
HEAD `68580abfca` PASS（证据 §10）、Windows GHA 在 `c966107b19`（代码 HEAD `68580abfca`）PASS
（run [`40205892750`](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40205892750)，
证据 §10）；分支 CI 通过后在 PR head 又复跑 Windows GHA
[`40223939433`](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40223939433)
（PASS，证据 §11）。**跨机器验收按 owner 裁定 R-ACCEPT-1 由 Windows GHA 替代**：没有第二台
Windows 消费机；这是“豁免/替代”，**不写成“跨机器验收 PASS”**。残余风险：未验证真实
macOS→Windows 的机器/OS 边界；触发条件：获得第二台 Windows 机器时按 Windows 证据 §4 四步补跑。
M2 完成判定为 **COMPLETE WITH WAIVER**；不得 tag/release，不得对外宣称跨机器验收已实际通过。
最终全量门禁 `corepack yarn check` 在 `68580abfca` 以 exit 0 通过。

本文所有复选框均表示**整改已完成且验收证据已归档**。初始状态均为未整改；不得仅因代码已改动、测试已增加或既有套件转绿就勾选。**唯一例外是 I-17**：其复选框表示「整改动作与现有可得证据已归档」；跨机器子项按 R-ACCEPT-1 由 Windows GHA 替代（owner waiver），这不是“跨机器验收实际通过”的声明。

建议整改顺序：

1. **安全与数据完整性**：I-1、I-2、I-3、I-5～I-14。
2. **功能、发布与运行时闭包**：I-4、I-15、I-16、I-19、I-20，并同步处理相关 Minor。
3. **范围与验收收口**：I-17、I-18，最后执行本文第五节的完整门槛。

---

## 二、Important 整改清单

### A. 包格式、签名与依赖闭包

#### I-1　未知或损坏的 tar 条目可能被静默忽略

- [x] **整改完成并归档验证证据**
  - 整改提交：`20500ad899`（`fix: reject ignored tar entries and raw backslash paths`）；`f460f4ee24` 订正解包计量注释。
  - 回归证据：`packages/agent-package-format/tests/bundle.test.ts`「rejects unknown tar entry types instead of silently ignoring them」「rejects archives whose header checksum cannot be trusted」「rejects malicious archive entries and duplicates」；`unpackCapped` 对未知 typeflag、`ignoredEntry` warning、坏 checksum 统一 fail-closed。
- **位置**：`packages/agent-package-format/src/bundle.ts:410-419`
- **问题**：解析器未启用 `strict`，也未处理 `ignoredEntry`/warning。未知类型条目可附在有效签名归档中而不进入 digest 文件集，违反“额外内容一律拒绝”。
- **整改动作**：让所有未知条目、无法识别类型和解析警告 fail-closed；不得以忽略条目继续生成已通过验签的文件集。
- **验收标准**：新增原始 tar header 的未知 typeflag、坏 checksum、可恢复 warning 负例；所有入口均拒绝，合法归档 round-trip 不受影响。

#### I-2　Windows 下反斜杠可能在校验前被规范化

- [x] **整改完成并归档验证证据**
  - 整改提交：`20500ad899`。
  - 回归证据：`packages/agent-package-format/src/bundle.ts` 在 tar 平台规范化前校验原始 header 路径；`bundle.test.ts`「rejects raw backslash paths on a Windows-normalizing tar」以子进程 `TESTING_TAR_FAKE_PLATFORM=win32` 运行 `tests/fixtures/windows-normalization-probe.ts`，POSIX 与 Windows 归一化两种模式同结果拒绝。
  - 严重度按裁定 R-M2-6 记为 Medium（仍是 fail-closed 修复，验收标准不变）。
- **位置**：`packages/agent-package-format/src/bundle.ts:360`、`:463-470`
- **问题**：当前校验 tar 已处理后的 `entry.path`。Windows 上 `skill\script.mjs` 可先变成 `skill/script.mjs`，造成平台语义不一致及既有负例失效。
- **整改动作**：在 tar 的平台规范化之前校验原始 header/PAX 路径，确保反斜杠在所有操作系统上均被拒绝。
- **验收标准**：Windows 与 POSIX 使用同一恶意归档得到同一拒绝结果；原始反斜杠、PAX 路径和 `./` 组合均有覆盖。

#### I-3　归档、签名和安装目录的条目预算口径不闭合

- [x] **整改完成并归档验证证据**
  - 整改提交：`8ad5b95449`（`fix: unify agent-package entry budgets across submit, sign and install`）。
  - 回归证据：`packages/agent-package-format/tests/digest.test.ts`「rejects more than 1024 file entries and accepts exactly 1024」「counts directories against the same 1024 entry budget」；`bundle.test.ts`「counts signature entries against the shared 1024 entry cap」「reserves the two signature files and the .signature directory in the 1024-entry budget」「counts implicit parent directories before accepting a signed bundle」；`agent-catalog-server/tests/submissions.spec.ts` 与 `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts` 覆盖 submit→approve→install 一致结论，超限返回 4xx。
- **位置**：`packages/agent-package-format/src/bundle.ts:348-355`、`packages/agent-package-format/src/digest.ts:188-197`、`agent-catalog-server/src/submissions.ts:591`、`:903`
- **问题一**：1024 条目的 unsigned 包可被接收，approve 增加两个签名文件后必然超帽。
- **问题二**：归档未计入隐式父目录，安装目录却计入，可能出现“验签通过、安装后复验失败”。
- **整改动作**：统一提交、签名、解包和目录枚举的条目预算；计入签名文件及所有唯一隐式父目录，并在提交时提前拒绝无法形成合法 signed bundle 的包。
- **验收标准**：覆盖 1024/1025 边界、无显式目录条目、嵌套隐式父目录和 `.signature/`；同一包在 submit、approve、install、运行前复验四处结论一致，超限返回客户端可理解的 4xx 而非 500。

#### I-4　新增运行时代码未完整纳入许可证和 notices 闭包

- [x] **整改完成并归档验证证据**
  - 整改提交：`ac267e88c0`（`fix: bring bundled agent-package runtime into the license and notices graph`）；`0b22d95f20`（把 bundled-runtime gate 留在 huaanwork 变体预算内）。
  - 回归证据：`dsh-plugin-huaanwork/scripts/huaanwork-bundled-runtime.spec.mjs` + `scripts/huaanwork-verify-bundled-runtime.mjs` 钉住 tsdown bundle/external 边界；`scripts/verify-licenses.mjs` 扩展为安装态 production 图 + pushed `lib/` bundled 闭包（`@huaanwork/*`、`tar` 及其依赖）；`THIRD_PARTY_NOTICES.md` 由 `verify:notices` 重生成且无漂移；`scripts/verify-desktop-variants.mjs` 第 65 项登记 `scripts/verify-licenses.mjs`（裁定 R-T12-1）。最终门槛中 `verify:licenses`/`verify:closure`/`verify:notices`/`verify:bundled` 全绿，见范围裁定附录 A。
- **位置**：`dsh-plugin-huaanwork/package.json:418-419`、`packages/agent-package-format/package.json:25`、`dsh-plugin-huaanwork/scripts/verify-licenses.mjs:113-124`
- **问题**：共享运行时位于 `devDependencies`，`tar` 又未进入 huaanwork 的直接生产许可证图；现有检查无法证明实际打包代码及其第三方闭包已完成许可证审查。
- **整改动作**：明确 tsdown bundle/external 模型，使全部运行时和第三方生产闭包进入许可证、notices 与打包解析验证。不得只移动 workspace 而遗漏 `@huaanwork/policy` 的 license 处理。
- **验收标准**：构建钉证明第一方代码的 bundle 边界及 `tar` 的 external/bundle 边界；`verify:licenses`、`verify:closure`、双平台包解析通过；`verify:notices` 后无漂移，新增闭包均有记录。

### B. 目录服务与管理员 CLI

#### I-5　状态变更可先生效，随后才写审计

- [x] **整改完成并归档验证证据**
  - 整改提交：`d34ebd0f7a`（`fix: bind catalog mutations to durable audit intents and validate state`）；`8667098233` 订正丢失去向对账的文案。
  - 回归证据：`agent-catalog-server/tests/audit.spec.ts`「refuses a write with 500 audit-write-failed when the intent journal cannot be written」「reconciles a committed mutation at restart and keeps the intent identity fields」「reconciles an intent that committed before the result record was written」「threads one request id through the intent and the result line」。
  - 按裁定 R-M2-1 采用 Option A：非 GET 先生成 `requestId` 并写 intent 审计，`store.mutate` 记录 `lastMutation`，重启对未闭合 intent 追加对账；完整 durable journal + 自动状态重建（Option B）不在本轮。
- **位置**：`agent-catalog-server/src/server.ts:340`、`:504`、`agent-catalog-server/src/submissions.ts:965`
- **问题**：handler 先提交，`finish()` 后写审计。审计失败或两次写入之间崩溃，会留下“客户端收到 500，但操作已生效且无审计”的状态。
- **整改动作**：用可恢复事务或 durable intent journal 绑定状态与审计；启动时完成 reconciliation，不能仅依赖 failure latch 阻止后续请求。
- **验收标准**：覆盖审计首写失败、状态已写后审计失败和两次写入之间崩溃；重启后不得出现无审计的成功变更，客户端结果与最终状态可对账。

#### I-6　撤销列表超过 1 MiB 后会永久性刷新失败

- [x] **整改完成并归档验证证据**
  - 整改提交：`2deb766562`（`fix: page revocation sync and fail closed on malformed entries`）。
  - 回归证据：`agent-catalog-server/tests/governance.spec.ts`「pages the revocation list and never exceeds the JSON cap」「rejects invalid revocation cursors and page limits」；`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts`「follows every revocation page before the list counts as complete」「rejects a server that never stops paginating」「offline refresh uses the cached revocations and reports a warning」。
- **位置**：`agent-catalog-server/src/governance.ts:620-635`、`agent-catalog-server/src/server.ts:323-330`、`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts:275-286`
- **问题**：全部撤销一次返回，超过响应帽后持续 500；桌面长期使用旧缓存，新撤销可能永远不可见。
- **整改动作**：实现分页或增量撤销同步，支持完整追平且不使用截断列表冒充成功。
- **验收标准**：构造超过 1 MiB 的撤销集，客户端能在每页小于上限的前提下完整同步；中途失败保留旧进度并告警，恢复后可续传，最终新撤销实际生效。

#### I-7　崩溃恢复可能让 metadata 与 bundle 中的签名不一致

- [x] **整改完成并归档验证证据**
  - 整改提交：`ef3968ea4f`（`fix: keep published metadata bound to the adopted bundle signature`）。
  - 回归证据：`agent-catalog-server/tests/submissions.spec.ts` 覆盖 bundle 已 rename、state 未提交的崩溃窗口；不同 `signedAt` 与不同有效 key 重试后，state 持久化的是被采用 bundle 实际验出的签名，metadata/下载字节/验签结论一致。
- **位置**：`agent-catalog-server/src/submissions.ts:952-976`
- **问题**：采用既有 bundle 时只比较 digest，却把本次请求的新 `signature` 写入 state。不同 `signedAt` 或有效轮换 key 会使元数据与下载字节描述不同签名事件。
- **整改动作**：持久化从被采用 bundle 实际验出的签名，或用新签名重建整个 bundle；保证 metadata 与字节始终一致。
- **验收标准**：在 bundle rename 后、state commit 前注入崩溃；分别用不同 `signedAt` 和不同有效 key 重试，最终 metadata、下载 bundle 和验签结果完全一致。

#### I-8　CLI 与验收探针的秘密输出防线均可绕过

- [x] **整改完成并归档验证证据**
  - 整改提交：`daca86e918`（`fix: redact secrets from CLI output and acceptance failure reports`）。
  - 回归证据：`agent-catalog-admin/src/redaction.ts` 集中 redaction；`agent-catalog-admin/tests/cli.spec.ts` 覆盖 manifest description、persona 响应、远端错误、CLI 失败输出与 PEM 块；`dsh-plugin-huaanwork/scripts/huaanwork-acceptance-redaction.mjs`（探针 redaction helper，裁定 R-T7-1，`scripts/huaanwork-` 前缀下不占 variant 名额）由 `tests/huaanwork-host/agent-package-m2-redaction.spec.ts` 与探针共用；异常抛出前先完成扫描与清理。
- **位置**：`agent-catalog-admin/src/review.ts:245`、`agent-catalog-admin/src/cli.ts:203`、`agent-catalog-admin/src/client.ts:292-309`、`dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs:350-360`
- **问题**：manifest 和远端错误正文可原样进入 CLI 输出；探针又在秘密扫描前把失败 stdout/stderr 抛入错误报告。
- **整改动作**：对 CLI stdout/stderr、远端错误和探针错误报告实施集中 redaction；任何异常抛出前先完成秘密扫描与清理。
- **验收标准**：覆盖 token 位于 manifest description、persona 响应、远端错误、CLI 失败输出及 PEM 块的用例；所有 stdout/stderr/JSON/日志均不含秘密。

#### I-9　重复 legacy 名称可掩盖 tool 冲突

- [x] **整改完成并归档验证证据**
  - 整改提交：`a37922a703`（`fix: reject ambiguous legacy slug conflicts and redact parser logs`）。
  - 回归证据：`agent-catalog-server/tests/submissions.spec.ts` 覆盖 agent/tool 两种排列与重复 agent、重复 tool、agent+tool；`agent-catalog-server/tests/auth-legacy.spec.ts` 覆盖 legacy 读路径；提交与批准均检查全部匹配项，不依赖文件顺序。
- **位置**：`agent-catalog-server/src/legacy.ts:45-47`、`agent-catalog-server/src/submissions.ts:414`、`:493`
- **问题**：只检查第一个同名 legacy 条目。agent 在前、tool 在后时，迁移可绕过 tool 冲突规则。
- **整改动作**：提交与批准均检查全部匹配项；任一 tool 匹配或歧义身份均拒绝，不依赖文件顺序。
- **验收标准**：agent/tool 两种排列均覆盖提交和批准路径；重复 agent、重复 tool、agent+tool 均有确定结果及审计。

### C. 桌面宿主、状态与生命周期

#### I-10　取消路径既可能永久卡住，也可能虚报清理成功

- [x] **整改完成并归档验证证据**
  - 整改提交：`b2f485ca3d`（`fix: serialize package transactions and propagate cleanup failures`）；`3a4a6a499d`（`fix: bound cleanup waits once and keep result timeouts out of failures`）。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/host-runtime-dispose.spec.ts`「reports a dispose timeout from the cancel path instead of silently claiming cleanup succeeded」「disposeAgentPackageRuntime awaits a slow stop-all before resolving」「a stuck child result does not contaminate a cancel that lands during idle cleanup」；`tests/huaanwork-host/agent-package-lifecycle.spec.ts` 覆盖 dispose 永不 settle / reject / `stopRuntime` reject / 同 slug 多条记录。update/remove 在停止未确认前不改名目录，调用方收到明确失败或 warning。
  - **表述按裁定 R-M2-5 订正**：保留 600 秒 `settleWithin` 上限；「无超时」的说法删除——准确表述是**底层 `dispose()` 不可取消且其所有失败被吞**，本轮修的是等待有界、`finally` 内停止 runtime、错误向上传播，而不是给上游 `SubagentActivationHandle` 增加 abort 语义。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:151-157`、`:555-573`
- **问题**：底层 `dispose()` 不可取消且其失败被吞，runtime 停止错误和 `record.cancel()` 错误也被吞。撤销时可能残留进程，update/remove 则可能把停止失败当作成功。
- **整改动作**：给等待设上限（保留既有 600 秒 `settleWithin`）；无论 dispose 成功、拒绝或超时都在 `finally` 中停止 runtime 并完成其余清理；尝试全部记录后向上报告失败。
- **验收标准**：分别覆盖 dispose 永不 settle、dispose reject、stopRuntime reject 和多条同 slug 记录；不得残留进程，update/remove 在停止未确认前不得改名目录，调用方收到明确失败或 warning。

#### I-11　更新/移除缺少覆盖整个事务的 per-slug 生命周期互斥

- [x] **整改完成并归档验证证据**
  - 整改提交：`b2f485ca3d`。
  - 回归证据：新增 `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/lifecycle.ts` 与 `tests/huaanwork-host/agent-package-lifecycle.spec.ts`「a same-slug update blocks a new dispatch until the whole transaction finishes」「a rejected stopTurns aborts update before the directory is renamed」；占位在事务完成前不释放，旧 cleanup 不会解绑新回合。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:145-150`、`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-install.ts:423-425`、`:665-674`
- **问题**：当前回合快照停止后仍有下载、验签和等待窗口；新 dispatch 可在此期间登记并跨越目录替换运行。会话占位还在清理完成前被释放。
- **整改动作**：增加从取消前到事务完成的 per-slug 生命周期门禁；dispatch 必须在登记前同步检查，取消中的占位不得提前释放。
- **验收标准**：用 deferred download/dispose 卡住事务，期间同 slug 新 dispatch 必须拒绝；事务成功、失败和回滚后门禁均能释放，旧 cleanup 不得解绑或停止新回合。

#### I-12　畸形撤销条目被丢弃，残缺列表反而被信任

- [x] **整改完成并归档验证证据**
  - 整改提交：`2deb766562`。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts`「rejects any malformed revocation item instead of truncating the list」「keeps the previous revocation cache when any page is malformed」「a corrupt cache is backed up with a warning instead of being treated as empty」；`catalog-client.ts` 任一畸形条目即拒绝整个响应，安装 fail-closed、刷新保留旧缓存并告警。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts:717-735`、`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts:289-298`
- **问题**：非法条目被 `continue` 跳过，随后残缺列表覆盖旧缓存并被视为刷新成功。
- **整改动作**：任一撤销条目畸形即拒绝整个响应；安装 fail-closed，刷新保留旧缓存并返回 warning。
- **验收标准**：在列表中分别放入缺字段、错类型和空字符串条目；缓存字节不变、warning 可见、被遗漏版本不会被当作未撤销。

#### I-13　运行前验签未绑定请求身份与磁盘 digest

- [x] **整改完成并归档验证证据**
  - 整改提交：`539ef59bb4`（`fix: bind runtime verification to the installed identity and guard recovery`）；`70c5042cae`（补 state-vs-disk 身份门禁回归钉）。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts` 的 `catalog installed identity binding` 组：「refuses to run when the directory is a valid signed v2 but state says v1」「refuses to run when the disk version is requested but state names another version」「refuses to run a valid directory with no catalog state entry」「refuses to run a revoked version even when state and directory agree」「refuses to run a signed package whose digest belongs to another slug」「refuses to run when the verified digest changes between the two checks」；`agent-package-runtime.spec.ts` 覆盖启动路径。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts:303-311`
- **问题**：`verifyInstalled()` 返回的 digest 身份未参与判定。目录被替换成有效签名的 v2、state 仍为 v1 时，可只检查 v1 撤销却运行 v2。
- **整改动作**：要求 digest.slug/version、dispatch 请求身份和 installed state 三者完全一致；任一不符均拒绝运行。
- **验收标准**：覆盖 state v1 + 有效签名 v2、v2 已撤销、slug 不匹配和验签期间目录再次变化；不得运行替换内容。

#### I-14　迁移恢复可能在无可用包时仍删除 legacy 和恢复证据

- [x] **整改完成并归档验证证据**
  - 整改提交：`539ef59bb4`。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts`「keeps the legacy key and transaction when no package or backup can be restored」「rolls a committed migration back when the legacy key cannot be deleted」「rolls a committed migration back when agents-enabled.json is corrupt」「deletes the legacy key when a migration committed but had not deleted it」；删除 legacy 与 transaction/old 前确认正式目录存在且有效，否则重建或恢复并保留证据。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-install.ts:743-782`
- **问题**：先补删 legacy，再检查 formal；即使 formal、staged package 和 old 都不存在，仍可清理 transaction/old，留下无目录的 target-version state。
- **整改动作**：删除 legacy 和 transaction/old 前确认正式目录存在且有效；否则重建新包或恢复安装前状态，并保留证据供下次恢复。
- **验收标准**：注入“state 已提交、formal 缺失、legacy 删除先失败后成功”的冷启动恢复；最终必须存在可复验的新包或完整 legacy，不得两者皆无，也不得双份启用。

#### I-15　服务端提交成功后，本地仍可能永久丢失 submissionId

- [x] **整改完成并归档验证证据**
  - 整改提交：`425c0f39fe`（`fix: make package publication idempotent across crashes and retries`）；`aae95cef7e`（`fix: reconcile stale submissions and keep newer publications`）。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-publish.spec.ts`「records the remote submission before a local state failure and reuses it on retry」「recovers a lost 201 by resubmitting with the recorded key」「keeps the stale sidecar and names the pending submission when content changed」「reconciles a recorded pending submission through getSubmission on refresh」「a commit during a status refresh does not resurrect the cleared submission」；同 slug 发布经 `publish-lock.ts` 串行化，服务端以 `idempotencyKey` 去重（`agent-catalog-server/tests/submissions.spec.ts`）。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-publish.ts:117-135`
- **问题**：上传成功后版本检查失败会直接抛错，不保存已经创建的远端 submission；旧内容可被批准发布，本地却无发布身份和下架句柄。
- **整改动作**：串行化同 slug 发布与内容 commit，或显式保存并对账所有已成功创建的远端 submission；过期状态守卫不得丢弃远端事实。
- **验收标准**：覆盖服务端已 pending 后本地 commit、201 丢失、本地状态写失败及等待期间 admin approve；重试后能恢复原 ID/status，无失控远端记录。

#### I-16　中断后的幂等 commit 会绕过发布状态复位

- [x] **整改完成并归档验证证据**
  - 整改提交：`425c0f39fe`；`aae95cef7e`。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts`「an idempotent commit retry resets publication before deleting the draft」「keeps the draft when the publication reset fails」「a completed commit retry keeps a newer publication instead of resetting it」「a stale draftId does not reset a newer publication or delete a different draft」；幂等完成路径先复位 publication，reset 失败保留可恢复证据。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts:234-251`、`:301-309`
- **问题**：`alreadyCommitted` 分支在 publication reset 前返回并删除草稿。中断发生在包写入后、reset 前时，新内容会保留旧 published/pending 身份。
- **整改动作**：幂等完成路径必须先完成 publication reset，再删除草稿和报告成功；reset 失败必须保留可恢复证据。
- **验收标准**：在包写入后、reset 前注入失败/重启，重试 commit 后发布状态为 `none`，旧 submissionId 被清理，enabled 和 publishedVersion 历史符合契约。

### D. UI、验收与范围约束

#### I-17　现有证据不能支撑 HEAD 或 Task 13 验收

- [x] **整改动作完成；跨机器子项按 R-ACCEPT-1 由 Windows GHA 替代（owner waiver，不是“PASS”）**
  - 整改提交：`650e749af7`（探针改走真实 `agent.packageRefresh` RPC 组合链，`host.listLocal()` 降级为标注的交叉核对）；`f2eebef933`（归档权威 macOS 运行）；`93c1bb0291`（GHA 改用 `--experimental-transform-types`，裁定 R-T13-1 选项 (b)）；`32db078253`、`2069df57d3`、`1c968f9e34`（Windows 证据文档订正）；final fix wave 之后在最终代码 HEAD `68580abfca` 复跑 macOS，并以 `c966107b19` 触发 Windows GHA run `40205892750`（证据均见各文件 §10）。
  - **macOS（最终 HEAD）**：代码 HEAD `68580abfca`，`node --experimental-transform-types scripts/huaanwork-agent-package-m2-acceptance.mjs --platform darwin` **exit 0**，11 个字段全 `true`、`residualProcesses=0`；权威记录 `docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md` §10，原始 JSON `docs/evidence/2026-10-25-agent-package-m2-darwin-finalfix.json`。
  - **Windows GHA（最终 HEAD）**：run [`40205892750`](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40205892750)（运行 commit `c966107b19`，代码 HEAD `68580abfca`，`windows-latest`，Node `v22.23.2`）：M1 step `0`、M2 step `0`，M2 JSON `verdict=PASS`/`exitCode=0`/`residualProcesses=0`，artifact `windows-agent-package-acceptance`；记录 `docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md` §10。更早的绿 run `40198346429` 保留在 §9，失败 run `40195462983` 保留在 §8，均不被覆盖。
  - **跨机器验收：按 R-ACCEPT-1 由 Windows GHA 替代（owner waiver）**——没有第二台 Windows 消费机；用 PR head 上的 Windows GHA run `40223939433`（win32，M1/M2 PASS，`residualProcesses=0`）作为 Windows 平台验收，**不写成“跨机器验收 PASS”**。残余风险：未验证真实 macOS→Windows 的机器/OS 边界；触发条件：获得第二台 Windows 机器时按 Windows 证据 §4 四步补跑。§五该项按 waiver 勾选。
- **位置**：`docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md:6`、`:603`、`docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md:3`、`:63`、`dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs:919-929`、`:982`
- **问题**：macOS 证据对应较早的 `c144a73383`；Windows 和跨机器验收仍为 BLOCKED；探针直接调用 helper，绕过了要求的 `agent.packageRefresh` 组合链。
- **整改动作**：保持 M2 未收口；让探针通过真实 RPC/route 验证返回卡片，在最终 HEAD 重跑 macOS、Windows GHA 和真实的 macOS 创建者到 Windows 消费机器流程。
- **验收标准**：证据记录最终 HEAD、真实 run URL、exit code、原始 JSON 和进程清单；delisted/revoked 可见性来自真实 packageRefresh 结果。原标准的“跨机器为实际 PASS”由 **R-ACCEPT-1** 改写为“Windows GHA 替代 + 残余风险 + 第二台 Windows 机器时补跑”，不得把同机双 Profile 写成跨机器 PASS。

#### I-18　存在未经裁定的计划外文件改动

- [x] **整改完成并归档验证证据**
  - 整改提交：`docs: record M2 scope ruling and remediation evidence`（本清单所在提交；精确 SHA 用 `git log -1 --format=%H -- docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md`）。
  - 回归证据：`docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md` 逐文件记录四个计划外文件的改动、理由、`git diff c411d12d89..<head> -- <file>` 证据与 R-M2-2 批准（2026-10-25）；M2 计划 Global Constraints 与 Modify 表已同步这四个文件；AGENTS.md 的 variant 权威计数同步为 65（R-T14-1）。除这四个文件外无其他计划外改动。
- **位置**：`dsh-plugin-desktop/tests/package.spec.ts:113`、`dsh-plugin-desktop-beta/tests/package.spec.ts:123`、`market-server/Dockerfile:5`、`docs/market-server-deployment.md:87`
- **问题**：这些文件超出 M2 Global Constraints 的允许范围。技术上必要的部署或门禁同步也不能静默越过已声明边界。
- **整改动作**：逐项取得明确范围裁定并同步计划/记录，或恢复到基线；不得以“测试需要”替代裁定。
- **验收标准**：每个文件均有“保留的裁定链接”或“已回退”的 diff 证据；相关变体、部署和根门禁按裁定通过，diff 中不再有未批准越界项。

#### I-19　本地同名包被误判为已安装目录包

- [x] **整改完成并归档验证证据**
  - 整改提交：`2a85ddfe80`（`fix: surface local-slug conflicts and stop swallowing manual refresh`）。
  - 回归证据：`dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts`「keeps a remote summary when a local package has the same slug」「does not suppress a signed summary for an installed catalog package」「never says all installed when a local-slug conflict remains」「says all installed only when every summary is an installed catalog package」；`agents-plaza-m2.spec.ts`「本地同名包不再吞掉远端摘要：摘要卡标冲突，只提供详情」；只有 `source === 'catalog'` 的已安装记录抑制广场摘要。
- **位置**：`dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts:353-356`
- **问题**：所有 `packages` 都参与 installedSlugs，导致本地同名包隐藏其他创建者发布的签名摘要。
- **整改动作**：只让 `source === 'catalog'` 的已安装记录抑制广场摘要；本地 slug 冲突单独呈现，不伪装成已安装。
- **验收标准**：本地同名 + 远端签名包仍显示签名卡及冲突提示；真正已安装 catalog 包不重复出现；空态文案不再误报“全部已安装”。

#### I-20　未安装签名包详情缺少计划要求的信息

- [x] **延后裁定 R-M2-3（不实现，不新增 RPC）**
  - 裁定：未安装卡继续只显示摘要；安装前签名 metadata 需要第 8 个 RPC（`agent.packageDetail` 扩展或新方法），会改动 M2 固定的 62→69 契约与 route-contract 计数，故不在本轮。
  - 触发条件：产品明确要求安装前审查签名 metadata，或下一次 UI 功能波。
  - 责任与工作量：触发后单独立项（新增 RPC + 面板渲染 + 契约计数同步）。
- **位置**：`dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx:536-540`、`:576-599`
- **问题**：未安装卡跳过 detail RPC，只显示摘要和“安装后可查看”，用户无法在下载前审查发布状态、digest 和签名。
- **整改动作**：提供安装前的签名 metadata 详情路径，并渲染 publishStatus/publishedVersion、digest 文件清单、keyId、signedAt、slot 和 verification。
- **验收标准**：未安装卡无需安装即可查看全部规定字段；有效、无效和缺字段 metadata 均有明确展示；不得要求或暴露 admin token/私钥。

---

## 三、Minor 整改清单

#### M-1　签名文档可绕过目录 5 MiB 预算

- [x] **整改完成并归档验证证据**
  - 整改提交：`8ad5b95449`。
  - 回归证据：`packages/agent-package-format/src/digest.ts` 在跳过 digest 文件集之前把签名文档计入总字节预算，并在读取前执行 `MAX_SIGNATURE_DOCUMENT_BYTES = 64 KiB` 单文档上限；`digest.test.ts`「charges signature documents to the 5 MiB directory budget and caps one document」。
- **位置**：`packages/agent-package-format/src/digest.ts:199-205`、`:302-303`
- **整改动作**：签名文件在跳过 digest 文件集之前计入总字节预算，并在读取前执行单文档上限。
- **验收标准**：空白填充的超限 `signature.json`/`package-digest.json` 在完整读入前被拒绝，合法边界仍通过。

#### M-2　部分成功审计缺少 reason

- [x] **整改完成并归档验证证据**
  - 整改提交：`d34ebd0f7a`；`8667098233`。
  - 回归证据：`agent-catalog-server/tests/audit.spec.ts` 与 `tests/submissions.spec.ts`「a rejected submission records the review reason」、`tests/governance.spec.ts`「audits governance writes with the request id and never the tokens」；拒绝 submission 与下架申请成功审计写入 trim 后 reason、slug/version、submissionId/delistRequestId，且不含 token/私钥。
- **位置**：`agent-catalog-server/src/submissions.ts:1074`、`agent-catalog-server/src/governance.ts:341-350`
- **整改动作**：在拒绝 submission 和创建下架申请的成功审计中写入 trim 后 reason 及对应标识。
- **验收标准**：审计断言包含准确 reason、slug/version、submissionId/delistRequestId，且不含 token/私钥。

#### M-3　state 启动校验只有顶层形状

- [x] **整改完成并归档验证证据**
  - 整改提交：`d34ebd0f7a`。
  - 回归证据：`agent-catalog-server/tests/store.spec.ts`「rejects syntactically valid state with semantic corruption and leaves the file untouched」「reports the precise corrupt field for missing fields, bad enums and mismatched keys」「accepts every legal record shape including optional fields and lastMutation」；合法 JSON 中的 null 记录、未知 status、错配 key/version 均在启动时拒绝，原文件保留供恢复。
- **位置**：`agent-catalog-server/src/store.ts:57-75`
- **整改动作**：启动时验证所有持久化记录、状态枚举、身份字段和 key 关系，语义损坏必须 fail-closed。
- **验收标准**：合法 JSON 中的 null 记录、未知 status、错配 key/version 均在启动时拒绝，并保留原文件供恢复。

#### M-4　legacy 解析警告可能泄露内容

- [x] **整改完成并归档验证证据**
  - 整改提交：`a37922a703`。
  - 回归证据：`agent-catalog-server/src/legacy.ts` 对路径与 parser message 使用统一 secret redaction；`agent-catalog-server/tests/auth-legacy.spec.ts` 覆盖损坏 JSON 中含 token/PEM 标记时日志不出现秘密，坏文件跳过行为不变。
- **位置**：`agent-catalog-server/src/legacy.ts:36-39`
- **整改动作**：对路径和 parser message 使用统一 secret redaction，或只输出不含原文的静态诊断。
- **验收标准**：损坏 JSON 中含三种 token 或 PEM 标记时，进程日志不出现秘密；坏文件跳过行为不变。

#### M-5　签名损坏包仍可被启用并进入补全

- [x] **整改完成并归档验证证据**
  - 整改提交：`539ef59bb4`。
  - 回归证据：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`「does not enable, dispatch, or list a signature-invalid catalog package」；`tests/huaanwork-host/agent-package-drafts.spec.ts`「a broken package can be disabled but not enabled」；启用与 invocable 列表共用同一 catalog 验签/损坏判定，dispatch 继续 fail-closed。
- **位置**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:418-425`、`:439-445`
- **整改动作**：启用与 invocable 列表使用一致的 catalog 验签/损坏判定；仍允许关闭已启用损坏包。
- **验收标准**：结构正常但签名无效、keyring 缺失或被篡改的包不能启用、不出现在 `@` 补全；dispatch 继续 fail-closed。

#### M-6　broken legacy 卡重新出现启用动作

- [x] **整改完成并归档验证证据**
  - 整改提交：`2a85ddfe80`。
  - 回归证据：`dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts`「broken legacy is close-only even when disabled」「non-broken legacy keeps enable/disable plus detail」；`agent-packages-panel.spec.ts`「broken legacy 不渲染启用：已启用仍可关闭，未启用只剩详情」；broken 判定先于 legacy 常规启停。
- **位置**：`dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts:135-138`、`dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx:401`
- **整改动作**：broken 判定先于 legacy 常规启停；disabled broken 不显示启用，enabled broken 仍可关闭。
- **验收标准**：enabled/disabled 两种 broken legacy 均有 UI 动作与宿主回归测试，权限确认框不会被误打开。

#### M-7　周期刷新会吞掉手动刷新

- [x] **整改完成并归档验证证据**
  - 整改提交：`2a85ddfe80`；`de92536e09`（`fix: share the legacy refresh when package refreshes overlap`）。
  - 回归证据：`dsh-plugin-huaanwork/tests/client-huaanwork/agents-plaza-m2.spec.ts`「周期刷新在飞时手动刷新共享该请求，完成后仍执行 agent.refresh 并反馈」「首次刷新在飞时手动刷新共享同一轮请求，只发一次 agent.refresh」「等待在飞刷新时卸载：请求返回后不再调用 agent.refresh」；手动刷新在周期请求在飞时共享/等待该请求，只允许周期 tick 被跳过。
- **位置**：`dsh-plugin-huaanwork/src/client-huaanwork/AgentsView.tsx:81-95`、`:124-132`
- **整改动作**：手动刷新在周期请求在飞时共享或等待该请求，再完成 `agent.refresh` 和反馈；只允许周期 tick 被跳过。
- **验收标准**：fake timers 覆盖周期在飞时点击刷新；手动序列完整执行、只发必要请求且有成功/失败反馈，卸载后不更新状态。

---

## 四、建议回归证据索引

整改提交或评审记录应为每项关联以下证据，避免只留下“已修复”文字：

| 类别 | 必须归档的证据 |
|---|---|
| 包格式与安全负例 | 原始恶意归档/fixture 说明、跨平台结果、submit→approve→install→运行前复验的一致结论 |
| 服务端与 CLI | 真实 HTTP/CLI 集成测试、故障注入与重启恢复、审计内容、秘密扫描结果 |
| 桌面宿主 | deferred promise/崩溃窗口测试、真实 state 字节、进程与 registry 清理、冷启动恢复结果 |
| UI | 动作纯函数、RPC 契约、面板渲染、fake timers、键盘/焦点与错误反馈测试 |
| 打包与发布 | build、许可证、notices、runtime closure、双平台包解析和 variant 守卫结果 |
| 验收 | 最终 HEAD、run URL、exit code、原始 JSON、进程清单、真实 RPC 和跨机器证据 |

本轮整改的实际归档：每项的提交与测试名见上文各条；最终门槛命令/退出码见
`docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md` 附录 A。

---

## 五、最终收口门槛

只有以下项目全部满足，才可将 M2 标记为完成（跨机器项按 R-ACCEPT-1 由 owner waiver 满足，记为 complete with waiver）：

- [x] I-1～I-19 全部勾选，且每项都有代码、测试和复核证据；I-20 有 R-M2-3 延后裁定与触发条件。
- [x] M-1～M-7 全部修复，或具有明确的延后裁定、原因和触发条件；无静默残余。
- [x] 对整改后的新 HEAD 再做一次独立实现评审，无未处置的 Critical/Important。**已完成（2026-10-25，最终全分支评审）**：0 Critical、2 Important（sidecar latch、audit intent rotation）已由 final fix wave `b2821f27f7`/`68580abfca` 修复并经 scoped re-review 确认；7 项 Minor 按 R-FINAL-1～7 延后并记录触发条件。
- [x] `corepack yarn test` 通过（exit 0，15 个 workspace 全绿；见范围裁定附录 A）。
- [x] `corepack yarn typecheck` 通过（exit 0）。
- [x] `corepack yarn check:desktop-variants` 通过，白名单与裁定一致（7/65/6）。
- [x] `corepack yarn check` 通过（exit 0，含 `check:whitespace`；无 `verify:aa` 并发复现）；既有 `verify:aa` 并发债务按原纪律处理，未删步骤。
- [x] `node scripts/verify-layout.mjs` 通过，root workspace 与 gate fixture 同步。
- [x] huaanwork `verify:licenses`、`verify:closure`、`verify:notices`、`verify:bundled` 通过（均 exit 0），`verify:notices` 后无漂移。
- [x] macOS 验收在最终 HEAD 通过，并归档原始证据（代码 HEAD `68580abfca`，exit 0，证据 §10，原始 JSON 已归档）。
- [x] Windows GHA 探针实际运行通过，并归档 run URL、exit code 和 artifact（run `40205892750`，运行 commit `c966107b19` / 代码 HEAD `68580abfca`，证据 §10）。
- [x] macOS 创建者机器到 Windows 消费机器的跨机器验收 **按 R-ACCEPT-1 由 Windows GHA 替代（owner waiver）**；不是“跨机器验收实际通过”。替代 run：`40223939433`（win32，M1/M2 PASS）；残余风险：未验证真实 macOS→Windows 机器/OS 边界；获得第二台 Windows 机器时按 Windows 证据 §4 四步补跑。不得用同机双 Profile 结果写成“跨机器 PASS”。
- [x] 探针通过真实 `agent.packageRefresh`/RPC 验证下架与撤销的卡片数据，不再以 helper 结果代替产品链路（`650e749af7`）。
- [x] 所有计划外文件均有明确裁定或已回退，最终 diff 不含未批准越界改动（四个文件，R-M2-2）。
- [x] `git diff --check <base>..<final-head>` 通过，最终工作区干净（exit 0；`git status --porcelain` 空）。

---

## 六、本次评审实际验证与限制

| 检查 | 结果 |
|---|---|
| `git diff --check c411d12d89..1235f0bae2` | PASS |
| 关键高风险控制流人工复核 | 已完成；I-5、I-7、I-10～I-16 等均有 HEAD 源码依据 |
| 构建、单元测试、类型检查、完整门禁 | 本次未运行；遵守只读评审，未切换分支或生成构建产物 |
| macOS/Windows/跨机器新验收 | 本次未运行；仅核对既有证据，不能据此宣称通过 |
| 文件改动 | 本评审未修改实现；本整改清单为后续应用户要求新增的文档 |

整改轮（2026-10-25）的最终门槛在 `docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md`
附录 A 逐条记录命令与退出码；跨机器验收仍 `BLOCKED`，M2 未收口。

本清单是整改跟踪基线，不是修复完成声明。后续每次收口应更新对应复选框、关联提交和证据指针，并记录新的最终 HEAD。
