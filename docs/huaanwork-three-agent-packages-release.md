# 三个智能体包生产上架指引（typo-check / code-review / task-orch）

- 日期：2026-11-13（实施计划 Task 14；owner 裁定 R6）
- 性质：**指引，不是执行记录**。本仓库未触碰生产 catalog、未生成/未持有/未提交任何生产私钥；生产上架、生产签名与生产目录处置全部是 owner 运维动作（R2/R6）。
- 上级 runbook：`docs/huaanwork-agent-packages-m2.md`（下称 M2 runbook）。本文每一步只指向该 runbook 的既有章节，不另造命令。
- 设计来源：`docs/superpowers/specs/2026-11-11-three-agent-packages-plaza-design.md` §6.2；实测证据：`docs/evidence/2026-11-11-three-agent-packages.md`。

## 0. 对象与前提

三包源在 `dsh-plugin-huaanwork/agent-packages/{typo-check,code-review,task-orch}/`（Task 5–7 交付；manifest 与字节预算实测见证据文档 §10.2）。slug 即唤醒词（`@typo-check` / `@code-review` / `@task-orch`），中文 displayName 只用于展示（错别字检测 / 代码审查 / 任务编排）。

本里程碑的验证（Task 9 的隔离签名链路、Task 12 的 macOS 真机走查）只证明机制，不等于生产上架验收（见 §5）。

## 0.1 运行时前提（产品默认与档位）

- **递归深度**：产品默认 `subagent.maxDepth = 2`（R8，profile 组合层注入，开箱即用，不依赖用户手工设置）。typo-check 的双盲派发要求有效 maxDepth ≥ 2；深度不足或派发失败时 SKILL 如实降级为单会话多轮自审，严禁伪造双盲。已知边界：用户先存过同族字段（如 `maxActiveSubagents`）再通过设置面板清除/重置 `maxDepth` 后，仅在尚未触发下次磁盘重组的**瞬态内存窗口**内有效值暂时为 1（fail-closed）；待下次加载 / HMR / 包操作重新组合配置后即恢复产品默认 `2`（见 `AGENTS.md` 与证据文档〈安全加固波次（2026-11-13）〉I3 说明，真机瞬态行为待集成环境验证）。
- **Guard 档位**：typo-check 的提取步骤需要 **smart 或 full** 档（R9）。ask 档（产品默认）下包子会话没有审批界面，bash/pwsh 必然被拒；SKILL 被拒时如实告知用户切档，不伪造提取结果。验收隔离 profile 显式写 `guard_mode: "smart"`，不复制生产值。
- **Windows 提取**：处方为单条简单命令 `pwsh -EncodedCommand <base64>`（base64 编码 UTF-16LE 脚本，元字符自由，smart 档可放行）。行为覆盖在 `tests/huaanwork-host/typo-check-pwsh-extract.spec.ts`，已列入 `check:win-package:platform`（**将由** Windows CI 执行；本分支尚未推送，暂无 CI run，列入≠已有执行证据）；本机 macOS 无 pwsh，行为用例如实跳过，**Windows 真机项 BLOCKED**（R-ACCEPT-1 豁免先例），不得声称已验证。
- **工作区边界（R11）**：code-review/task-orch 两包 SKILL 声明 `read`/`glob`/`grep` 只允许当前会话工作区内路径；工作区外目标请用户把该文件夹作为工作区打开，或 smart/full 档改用 bash/pwsh 读取（ask 档诚实降级）。文件工具受工作区硬约束，bash/pwsh 受档位门控但不受工作区包含约束（R11）。typo-check 用 bash/pwsh 做提取（spec §5.1），不含该兜底节。

## 1. 前置退役：三条同名 kind:"tool" 条目必须先退役

生产 catalog 的 entriesDir 中，`typo-check` / `code-review` / `task-orch` 三条同名 legacy 条目（`kind:"tool"`）必须先退役，再发布同名智能体包。

- 代码事实：`agent-catalog-server/src/submissions.ts` 的 `legacyConflict()`（`:424-446`）对同名 legacy 条目一律返回 409 `legacy-conflict`；唯一例外是 `migrationFrom === slug` 且 `entry.kind === 'agent'`（`:439`），**tool 条目没有迁移路径**。该判定在提交与批准两个时点重跑（`findApproveConflict()`，`:541-558`），因此退役前提交与批准都会被拒；无同名条目时判定返回无冲突（`:429`）。
- 退役是部署侧运维动作：`{AGENT_CATALOG_ENTRIES_DIR}` 由服务端只读枚举、不属于目录服务状态（M2 runbook §2），本指引不提供新命令。
- 语义边界：下架（delist）只改目录元数据与已安装卡状态，**不是**安全处置（M2 runbook §8）；legacy 迁移即使 `migrate-legacy --submit` 也仍需照常审查（M2 runbook §13）。这两节说明为什么 tool 条目不能靠迁移或下架绕过，只能退役。
- 仓库内 `agent-catalog-server/tests/fixtures/entries/{typo-check,code-review,task-orch}.json` 是保留的测试数据，不是生产内容；生产 entriesDir 的实际内容由 owner 在部署目录核对。

## 2. 签名纪律：生产签名只用 owner 真实密钥

keyring、私钥与轮换纪律见 **M2 runbook §4**，上架时按原文执行。要点：

- 私钥只在离线签名机（PKCS#8 PEM，`chmod 0600`），从不进 git、不进 Profile、不进目录服务、不进桌面设置；`approve` 只在回执校验与 `--yes` 之后才读取它（§4、§6）。
- 公钥 keyring 由 IT 下发到每个需要安装/运行的 Profile（`{profileDir}/agent-catalog-keyring.json`；恰好一个 slot 1、最多一个 slot 2；`keyId` 等于公钥字节的 sha256）（§4）。
- 双槽轮换只经配置与发版；桌面端没有 keyring 编辑 UI（§4）。
- 测试 key 与生产 key 不共用：仓库内所有 keyring/私钥都是每次运行生成的临时材料，CI/验收探针的 key 永远不能进生产 keyring；生产 keyring 的公钥数量应与备份链记录一致（§4）。

仓库与任何脚本输出不生成、不持有、不提交生产私钥；本文不含任何私钥、keyring 或签名材料。

## 3. 上架步骤

### 3.1 播种：把三包写入生产 creator profile

```bash
node --experimental-transform-types dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs --profile <生产 creator profileDir>
```

- Task 8 脚本 `dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs`（usage 行写作 `scripts/seed-agent-packages.mjs`，在 `dsh-plugin-huaanwork/` 目录下执行即同一命令）；`profileDir` 由 owner 指定。
- 脚本把 `dsh-plugin-huaanwork/agent-packages/` 三包写入 `{profileDir}/agents/{slug}` 与 `{profileDir}/agents-state.json`；写入前对三包全量预检（manifest + 字节预算），任一包不合格即不写任何包。
- 此步是 owner 运维动作；「验收绝不触碰生产 profile」的约束只约束验收运行，不约束本指引（脚本头部同口径）。
- **发布后不要再重跑 seed**：脚本以 `replace: true` 写入并把本地状态重置为 `{enabled:true, publishStatus:'none'}`——重跑会替换源并重置本地发布状态，已发布包的本地发布记录丢失，须重新走发布/签名流程。仅在首次播种或确需重置时执行。

### 3.2 发布 → 离线审查 → 签名（M2 runbook §6）

- 桌面「我的智能体」提交发布（RPC `agent.packagePublish`）。
- 离线签名机执行 `pending` → `review <submissionId> --out ./review-<submissionId>`：admin CLI 与服务端各自独立复算 digest，字节不一致时拒绝写回执（§6）。
- 明确同意后 `approve <submissionId> --review ./review-<submissionId>/review.json --private-key <离线签名机私钥> --slot 1 --yes`：回执 digest 与服务端当前 digest 任一变化都拒绝签名（§6）。
- 驳回用 `reject --reason`（1–500 字符）；下架申请与撤销命令同见 §6。下架不是安全处置、撤销不可撤回，语义见 §8。
- 命令原文（含占位 token 与参数）只在 §6，本文不复述、不新增。

### 3.3 安装、更新、启用（M2 runbook §7）

广场出现三张签名卡后：首次安装默认关闭、需用户启用；更新只向上，低于已安装版本按降级拒绝；每次 `@slug` 运行前都从磁盘重新验签并检查撤销列表，两类失败文案不同；已安装包的发布状态按精确 metadata 刷新（§7）。

## 4. 与原目录删除的联动（R7）

- 顺序：生产上架完成并稳定运行后，owner 再次明确确认删除范围，才可删除三个原目录；未经再次确认绝不删除（R7）。
- 备份与范围：备份路径、sha256、三个绝对路径与延后删除的触发条件见证据文档 `docs/evidence/2026-11-11-three-agent-packages.md` 的「Task 13 原目录备份与延后删除」节（§13.1 备份产物 / §13.3 删除范围 / §13.5 触发条件）。
- 删除前按该节 §13.2 重新校验归档 sha256 未被改动（§13.5 第 ③ 条）；三个目录均无 git remote，归档是唯一安全网。
- 本文不含删除命令，也不改变 §13.5 的触发条件。

## 5. 验证边界

- Task 9 的签名链路验证（隔离 catalog + 每运行一次性 Ed25519 开发密钥）与 Task 12 的 macOS 真机走查只证明机制可用，**不等于**生产上架验收；这些运行未触碰生产目录、生产 keyring、生产 Profile 或生产签名。
- 生产上架后按 **M2 runbook §14** 复跑双 Profile 验收探针（macOS / Windows 命令原文见 §14）。边界以 §14 原文为准：探针自己起真实目录服务，使用**临时** entries/data/keyring 与一次性测试 key；同机双 Profile 是集成测试，不替代跨机器验收，也不复核生产目录本身。
- 生产侧的直接观察对象：广场出现三张签名卡、安装/更新/启用与运行前验签（§7）、下架与撤销的离线语义（§8、§11）。
- 跨机器验收状态沿用 M2 runbook §15 与 R-ACCEPT-1 口径：双平台本机/GHA 探针 PASS，跨机器 `BLOCKED`。本里程碑 Windows 真机项同样 `BLOCKED`（无第二台 Windows 机器），不得把 macOS 走查或隔离验证写成生产上架验收。
