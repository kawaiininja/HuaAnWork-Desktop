# 三个智能体包与广场接入设计规格及实施计划评审报告 (Review)

- **日期**：2026-11-12
- **状态**：**不通过，待修订（未达到直接实施标准）**
- **评审对象**：
  - 设计规格：[`docs/superpowers/specs/2026-11-11-three-agent-packages-plaza-design.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-11-three-agent-packages-plaza-design.md)
  - 实施计划：[`docs/superpowers/plans/2026-11-11-three-agent-packages-plaza.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-11-three-agent-packages-plaza.md)
- **基线 Commit**：`310540837b` (HEAD -> master)
- **战略定调**：Owner 确认按**【平台底层基建升级】**路线推进（确认采纳 C1~C5 运行时沙箱扩展，支持智能体包派发子代理并进行孙代收窄继承）。

---

## 1. 评审结论综述

根据 Owner 对原始需求与平台战略的最新裁定，本次改造明确确立为**【平台底层基建升级】**，即：
1. **肯定 C1~C5 运行时扩展方案**：为 `dsh-plugin-huaanwork` 打通“包内允许派发子代理 + 孙代工具继承收窄与执行期强制拦截”，作为平台级核心基建交付；
2. **肯定轻量化提取与宿主通读**：错别字检测智能体放弃跨厂商双模型与 `python-docx` 结构化定位，采用系统原生文本提取（macOS `textutil` / Windows `pwsh`）并由宿主模型通读检测；
3. **肯定任务编排与代码审查的纯 LLM 化**：代码审查与任务编排作为标准自包含技能包接入。

在此战略前提下，实施计划的技术设计细节具有很高的严密性（给出了完整的 TDD 失败与通过断言、上游相交语义适配、Fail-closed 拦截）。**然而，当前计划仍存在 2 项 P0 级致命硬伤、3 项 P1 级风险项，若不加修改直接执行，脚本必然在执行中途报错阻断，且无法达成真正的生产环境交付。**

---

## 2. 缺陷分级与修复要求

### 2.1 阻断项 P0（实施前必须修正，否则脚本中断或交付断环）

#### P0-1: Task 13 备份与删除命令路径错误（直接导致执行失败）

- **问题描述**：
  实施计划 Task 13 Step 1 与 Step 4 中的执行命令写为：
  ```bash
  # Task 13 Step 1
  tar -czf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz -C ~/Downloads/cursor 错别字检测智能体 代码审查智能体 任务编排智能体
  # Task 13 Step 4
  rm -rf ~/Downloads/cursor/错别字检测智能体 ~/Downloads/cursor/代码审查智能体 ~/Downloads/cursor/任务编排智能体
  ```
  在本地文件系统中，三个原智能体文件夹的真实路径为：
  - `/Users/amonmiao/Downloads/cursor/智能办公平台/错别字检测智能体`
  - `/Users/amonmiao/Downloads/cursor/智能办公平台/代码审查智能体`
  - `/Users/amonmiao/Downloads/cursor/智能办公平台/任务编排智能体`

  若直接在 `~/Downloads/cursor` 下执行 `tar -C`，系统会因找不到目标目录而抛出 `Cannot stat: No such file or directory` 并退出（Exit Code 1），导致整个自动化流程中断；同时 Step 4 删除命令作用于空路径，原目录无法被正常清理。
- **修复要求**：
  将设计规格 §8.1 与实施计划 Task 13 中的路径统一修正为真实相对路径或绝对路径：
  ```bash
  # 正确的备份命令
  tar -czf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz -C ~/Downloads/cursor/智能办公平台 错别字检测智能体 代码审查智能体 任务编排智能体
  # 正确的删除命令
  rm -rf ~/Downloads/cursor/智能办公平台/错别字检测智能体 ~/Downloads/cursor/智能办公平台/代码审查智能体 ~/Downloads/cursor/智能办公平台/任务编排智能体
  ```

#### P0-2: 生产环境真实上架与旧条目退役闭环缺失（交付目标未达成）

- **问题描述**：
  用户原始需求明确要求“将这 3 个 LLM 化的智能体在 huaanwork 智能体模块下的智能体广场页面下”。
  当前计划（Task 8、Task 9、Task 12）全部运行在**隔离的临时目录（Temp Profile）+ 临时模拟的 Catalog Server + 一次性开发私钥**下。
  现实生产环境（`/Users/amonmiao/Downloads/cursor/智能办公平台/agent-catalog-server/entries/`）中目前存在 3 个旧的同名 `kind: "tool"` 条目：
  - `typo-check.json`
  - `code-review.json`
  - `task-orch.json`

  根据 `agent-catalog-server` 的校验规则，任何同名旧 tool 条目在重新提交包时会强行抛出 HTTP 409 `legacy-conflict` 错误拒绝发布。计划将正式上架完全排除在实施范围之外（作为 owner 运维动作），导致**自动化实施完毕、原文件夹删除后，用户在正式使用的 HuaAnWork 智能体广场中根本看不到这 3 个智能体**，业务功能发生断档。
- **修复要求**：
  计划中必须追加 **Task 14（生产上架与正式发布闭环）** 或在 Task 9/13 之间增加正式生产发布流程指引：
  1. **生产目录旧条目退役**：备份并安全移除 `/Users/amonmiao/Downloads/cursor/智能办公平台/agent-catalog-server/entries/` 下的 3 个旧条目；
  2. **正式签名脚本**：提供使用 Owner 真实私钥签名的标准 CLI 执行指南；
  3. **正式客户端验证**：确保连接到正式目录的 HuaAnWork 客户端在广场中成功刷出 3 张带有正式签名的中文卡片。

---

### 2.2 重要项 P1（高风险/稳定性缺陷，实施前必须明确）

#### P1-1: 原目录删除时序倒置与数据安全隐患

- **问题描述**：
  `任务编排智能体` 包含高达 **248MB 的历史数据库（`orch.db`）**，且 3 个原项目均无 Git Remote，本地文件是唯一历史资产。
  现计划将“确认删除”放在临时走查（Task 12）之后、生产正式上线之前。如果用户确认删除了源码，而在后续生产环境接入或实际业务使用时发现新版提示词缺少原工程的某项细微逻辑，恢复成本极高。
- **修复要求**：
  - Task 13 的执行边界调整为：**只执行本地打包备份（tar）并校验 SHA-256，将备份文件妥善留存**；
  - **真正的物理删除操作脱离自动化脚本**，明确变更为：*“在生产环境正式上架、业务平稳运行 1~2 周无异议后，由 Owner 手工执行删除”*。

#### P1-2: Task 12 走查脚本对外部系统命令 `zstd` 的隐式依赖

- **问题描述**：
  Task 12 Step 3 明确规定使用 `zstd -d -c` 命令行工具多帧解压会话日志来统计子代理数量。
  macOS 系统默认并未自带 `zstd` 命令行工具。若在未安装或未配置环境的机器上运行，脚本会直接 Crash。
- **修复要求**：
  在 `scripts/huaanwork-accept-three-packages.mjs` 中增加环境依赖预检逻辑：检测 `which zstd`，若未安装则输出友好的环境准备提示（例如 `brew install zstd`），或提供备选的解压降级方案。

#### P1-3: 设计规格（Spec）与实施计划（Plan）口径脱节

- **问题描述**：
  计划的 Global Constraints 已经纠正：真实 UI 中签名包没有安装/启用弹窗，披露面仅为“详情对话框”；但设计规格 §5.0 与 §7.3 仍记载着“安装/启用对话框能力披露”。两份文档口径存在不一致。
- **修复要求**：
  同步将设计规格 §5.0 / §7.3 校准为与计划一致的“详情对话框”真实形态。

---

### 2.3 优化项 P2（交互体验与细节优化）

#### P2-1: 智能体唤醒词在描述与技能中的显式指引

- **问题描述**：
  智能体广场展示中文 DisplayName（`错别字检测`、`代码审查`、`任务编排`），但底层 `agent-invoke.ts` 的分发正则只识别英文 Slug（`@typo-check`、`@code-review`、`@task-orch`）。终端用户打 `@错别字检测` 无法派发。
- **修复要求**：
  在三包的 `agent.json` 的 `description` 以及 `SKILL.md` 顶部第一行，显式增加调用指引：
  > *“提示：在对话框中输入 `@typo-check`（或 `@code-review`、`@task-orch`）即可呼叫此智能体。”*

---

## 3. 修订后的实施任务矩阵（Task Roadmap）

完成上述修复后，实施计划将调整为以下 14 个完整闭环任务：

```
[基建扩展阶段]
Task 1: C1 允许名单加 subagent (runtime.ts)
Task 2: C2 血缘 holder + C3 绑定与引用清理 (holders.ts / host.ts)
Task 3: C4 孙代收窄与传递绑定 (skills.ts)
Task 4: C5 执行期强制 (policy.ts)

[包资产构建阶段]
Task 5: typo-check 包源文件 + 三包共测骨架 (含唤醒提示)
Task 6: code-review 包源文件 (含唤醒提示)
Task 7: task-orch 包源文件 (含唤醒提示)

[测试与安全评审阶段]
Task 8: 播种脚本与自测 (seed-agent-packages.mjs)
Task 9: 广场发布验证脚本 (verify-agent-packages-plaza.mjs)
Task 10: 全量门禁 + 证据文档 (typecheck, test, check)
Task 11: 独立安全代码评审 (针对 C1~C5 安全敏感文件)
Task 12: CDP 真机走查脚本执行 (包含 zstd 预检与 lane 计数断言)

[生产发布与归档阶段]
Task 13: 生产目录旧条目退役 + 正式签名发布与客户端上架闭环 (新追加 P0 项)
Task 14: 原目录路径修正备份（tar + sha256 归档留存，延迟物理删除） (修正 P0/P1 项)
```

---

## 4. 评审总结

在确立**【平台底层基建升级】**路线后，原设计规格的技术深度与方向已完全成立。只要在计划中完成 **P0-1（Task 13 路径修正）** 和 **P0-2（生产发布上线闭环）** 的修订，该方案即可完全达到工程实施标准，可安全启动执行。

---

## 5. 处置（2026-11-12，独立反证核实 + owner 裁定）

对上文 6 条意见逐条对照代码与文件系统反证，结论如下；修复已落入 spec 与计划（spec 登记 R6/R7，计划 Self-Review 第 5 节记录订正明细）。

| 意见 | 判决 | 处置 |
| --- | --- | --- |
| P0-1 Task 13 路径错误 | **属实，P0 恰当**。三目录实际在 `~/Downloads/cursor/智能办公平台/` 下；原 tar 必失败，`rm -rf` 指向不存在路径静默退出 0。根因是 spec §1 位置同样写错 | 已修：Task 13 tar/-C 与删除范围路径补层；spec §1/§8 同步订正 |
| P0-2 生产上架闭环缺失 | **事实真，定级越权**。spec §6.2 与 R2 裁定明示正式上架是 owner 运维动作、不在本里程碑代码范围；且 M2 已有部署与离线签名 runbook（`docs/huaanwork-agent-packages-m2.md` §6/§7/§13），「无 runbook」不成立 | owner 裁定 **R6**：不纳入代码范围，补 Task 14 runbook 指引任务。评审 §3 的「Task 13 生产发布闭环」路线未采纳 |
| P1-1 删除时序与数据安全 | **事实真，「恢复成本极高」夸大**。orch.db 248MB、三目录 .git 零 remote 均核实；但计划第一步即 tar 备份，路径修复后备份是真实安全网，恢复成本 = 解包 | owner 裁定 **R7**：删除延后到生产上架完成并稳定运行后；Task 13 重构为只备份 + 登记延后触发项，本里程碑不执行任何 rm |
| P1-2 zstd 隐式依赖 | **夸大，降 P2 处置**。无预检属实，但目标机器已装 zstd v1.5.7（PATH 可达），「直接崩溃」场景不成立 | 已修：Task 12 增 `requireZstd()` 预检，缺失 ⇒ BLOCKED exit 3 |
| P1-3 spec/plan 披露口径脱节 | **属实，但计划早已显式订正**（Global Constraints 订正条 + 不伪造对话框测试），执行不受影响 | 已修：spec §5.0/§7.3 措辞同步订正为详情对话框口径，文档卫生闭环 |
| P2-1 唤醒词显式指引 | **属实且原计划未覆盖**。`AT_INVOKE_RE` 只认小写 slug，中文 @ 不可派发；底层「@ 补全不匹配 displayName」已在 M1 残余债登记 | 已修：三包 description 末尾加「用 @slug 调用。」、SKILL.md 开头加调用行，各补回归钉；spec §3 中文 @ 图示同步改为 @slug |

**评审漏报（反证扫描发现，均已修复）：**

1. **Task 12 Step 2 选择器点错按钮**：`button.filter-tab:last-child` 想点「查看详情」，实际 DOM 顺序 [查看详情, spacer, 下载]，末位是「下载」⇒ 提前安装 + 详情等待超时。已改按文案匹配。
2. **Task 9 bootCatalog 两处 API 用错**：`createAgentCatalogRuntime` 是 async 未 await；`createAgentCatalogServer` 真实签名 `(config, runtime?)` 被写反。M2 先例脚本（:608-635）用法正确，计划抄错。已按先例同形修复（含 listen error reject 与 closeAllConnections）。
3. **Task 12 会话日志路径错误**：原写 `{homeDir}/profiles/desktop/.../sessions/`，实际在 `{homeDir}/sessions/{projectKey}/{编码会话id}/session.v4.jsonl.zstd`（DSH_HOME 根）。已修正，并改为按 `@typo-check` 派发文本定位目标会话（drive 依次跑三包，「最新会话」不一定是 typo-check）。

**探针项（不定性为 bug）**：孙代迟到 activation 的清理竞态，可达性取决于上游取消语义，留给 Task 11 独立评审核查。

**结论**：评审「不通过」结论成立，但依据需按上表校准；4 处阻断（含 3 处漏报）修复 + R6/R7 落地后，计划可进入执行。
