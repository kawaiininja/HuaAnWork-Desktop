# Agent 工具箱扩展 设计文档

**日期**: 2026-10-12
**状态**: 三项裁定已闭环（范围、搜索后端、目标仓）；组织方式经复挂 spike 重开后定为**三层结论**（L1+L2 复挂上游 / L3 自建）。2026-10-12 修订版三处裁定变更（复挂三层结论、web_fetch 局域网放行、后台任务移出范围）经逐项复核证据后由用户全部接受。待实施计划。
**配套文档**: `2026-10-12-agent-toolbox-spike-report.md`（运行时证据）、`2026-10-12-agent-toolbox-ab-criteria.md`（A/B 判据与回转条件）

## 背景

HuaAnWork agent 当前工具面 = 6 个 Git 工具（`git_status` / `git_diff` / `git_branch` / `git_checkout` / `git_commit` / `git_push`，接线于 `HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/git.ts`，纯逻辑在 `HuaAnWork-Desktop/packages/huaanwork-git-tools/`）。agent 无法看代码、改代码、验证改动，工作闭环断裂。

**关键事实：护栏层已提前建好。** `HuaAnWork-Desktop/packages/huaanwork-policy/src/decide.ts` 的 `decide()` 已为 `read`/`read_file`（`:78-79`）、`glob`/`grep`（`:81-82`）、`edit`/`write`（`:84-85`）、`str_replace_editor`（`:87`）、`bash`/`pwsh`（`:95-96`）预留判定 case（含 `resolveInside` 路径收拢、`classifyShell`/`isHardDenyShell`/`isHighRiskShell` 命令分级、三档护栏模式 ask/smart/full）。本轮实施 = 补齐工具侧，让 policy 层的既有判定生效，**不重写策略**。

## 已确认的裁定（2026-10-12 澄清轮）

1. **范围**: 四个优先级一次做完（只读三件套、写+执行+后台任务、截图、web_fetch）。
2. **搜索后端**: **本轮只交付 web_fetch，不做 web_search**。调研结论：Kimi Work/Trae/Qoder 的搜索均为云厂商服务端工具，对本产品（本地 OpenAI 兼容模型，服务端无搜索能力可借）不成立；本地优先阵营（Open WebUI/LibreChat）已收敛为「fetch 本地实现 + 搜索可配置 provider（SearXNG 自托管事实标准）或不自建走 MCP」。本产品 MCP 挂载机制已存在（`huaanwork-guardrails/agent-mcp.ts` 的 `mountSessionMcp`），搜索需求由用户挂搜索类 MCP server 满足。
3. **web_fetch 门控（2026-10-12 已敲定）**: 复用既有 `allow_network` 设置（`dsh-plugin-huaanwork/src/huaanwork-host/settings.ts`，配套 `net-gate.ts`）。**门控语义与既有 `workNetworkGateError` 一致**（`packages/huaanwork-policy/src/network.ts:81-88`）：`allow_network=true` 时无限制；`false` 时**公网地址被拒**（返回结构化错误「请先在 设置→权限 打开公网开关」），**本机/局域网地址照常放行**——内网用户抓内网文档页不需要打开公网开关。实现复用 `isLanEndpoint` 判定，不新写一套网段表。
4. **截图范围**: 只做截图（URL → headless 渲染 → 图片），不做完整浏览器控制（click/type/evaluate），不截应用自身窗口。
5. **组织方式（三层结论，2026-10-12 复挂 spike 后重开并定稿）**: 原案「新增四个纯逻辑包 + guardrails 四个接线模块」被实测数据推翻，改为按实现面三层分别处置：
   - **L1（read / glob / grep / write / edit）复挂上游 `@deepseek-ai/dsh-tool-fs` + `dsh-tool-fs-search`**。证据：这两个包随 `dsh-base` 已挂载、被 `dsh-web-app` overlay 关闭；变体层把行翻回 `disabled: false` 后，agent 立即拿到六件工具（工具目录 6 → 12），越界 read/write 被 deny、工作区内 read 放行，**零新增策略代码**（spike 报告 §3.2/§3.3）。`read` 的四个窗口旋钮（`readLimit`/`readMaxLineLength`/`readMaxBytes`/`readStreamMinSize`）已覆盖本文档对 `read` 的全部行为要求；`read_image` 被 `present-as.ts` 白名单自然挡住。
   - **L2（bash / pwsh 前台执行）复挂上游 `dsh-tool-bash` / `dsh-tool-pwsh`**。证据：审批走既有 `decideShell` 三档（实跑 `bash curl` 命中 ask；提权参数只越沙箱、不越策略，spike 报告 §4.5）。**后台任务本轮不做**（`jobs`/`tool-jobs` 是变体硬锁定，非配置项；`run_in_background` 随之关闭，见下方收口裁定与 §4.6）。
   - **L3（web_fetch / screenshot）自建**：上游 `tool-web` 依赖本变体没有的 `web` 服务，无法复挂；截图返回形态需先确认 attachment 面（`ImageBlock` 需要 `ImageAttachmentRef`，spike 报告 §4.8 附注）。
   - **preset 路径实测不可用**（本变体会话 `agentPreset` 恒为 `null`，standard 预设不贡献任何工具），已排除为备选。
   - 判据、回转触发条件与落地清单见 `2026-10-12-agent-toolbox-ab-criteria.md`。
6. **目标仓**（2026-10-12 写稿时发现并裁定）: 实施在 **HuaAnWork-Desktop**（新仓）。旧 Tauri 仓 `HuaAnWork` 已声明停维存档（README：「本版本已停止维护……继任者是 HuaAnWork Desktop」），新版同位置已有同构设施（`packages/huaanwork-git-tools`、`packages/huaanwork-policy` 同套预留 case、`huaanwork-host/net-gate.ts`）。本 spec 文档存放于新仓 `HuaAnWork-Desktop/docs/superpowers/specs/`（初稿曾按 M26 先例落在旧仓文档脊柱，用户裁定移至新仓）。

## 架构总览（均在 HuaAnWork-Desktop 内）

```
【L1/L2 复挂】不新增包。变体层只改配置：
dsh-plugin-huaanwork（变体 compose 层）
  └─ 把 dsh-base 已带来、被 dsh-web-app overlay 关闭的行翻回：
       tool-fs / tool-fs-search / tool-bash（win 平台为 tool-pwsh）
【L3 自建】新增一个包 + 一个接线模块：
packages/
  huaanwork-web-tools/      web_fetch / screenshot              （纯逻辑 + fetch/launch 缝）
dsh-plugin-huaanwork/src/huaanwork-guardrails/
  web.ts                    （薄接线，同 git.ts 模式；注入 allow_network 读取缝）
```

命名对齐 policy 既有 case：L1/L2 用上游工具名（`read`/`edit`/`write`/`glob`/`grep`/`bash`/`pwsh`，已被 `decide()` 预留）；L3 新增 `web_fetch`/`screenshot`。

**新仓规则约束**（来自 HuaAnWork-Desktop CLAUDE.md）：
- zero-touch 规则：本轮只动 `dsh-plugin-huaanwork/`，不碰 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`。
- variant 守卫：`src/huaanwork-guardrails/` 在 beta↔huaanwork 守卫的 6 条 oneSidedPrefixes 白名单内，新增接线文件零白名单成本；`packages/` 不在守卫覆盖面内。
- 提交前跑 `corepack yarn check:desktop-variants` 验证守卫仍绿。

## 各层设计

### L1/L2：复挂上游工具（本轮 0 新包、0 新策略代码）

**改动 = 变体 compose 层把三到四行行 enable**（`tool-fs`、`tool-fs-search`、`tool-bash`，Windows 为 `tool-pwsh`），并同步 `profile.ts` 的 `HUAANWORK_ROW_ASSERTIONS` 与 `tests/profile.spec.ts` 的行断言。

行为说明（上游实现，本轮不重写）：
- `read`：带行号输出、大文件流式读取、窗口上限由 `tool-fs` 的四个 Config 旋钮控制（`readLimit` / `readMaxLineLength` / `readMaxBytes` / `readStreamMinSize`）；需要调什么在这里调，不新增代码。
- `glob` / `grep`：ripgrep 后端（`@vscode/ripgrep` 随包分发，仓库已有 resolutions 补丁）。
- `write` / `edit`：写边界由 `fs-sandbox`(workspace-write) + 既有 policy 路径检查双重覆盖；上游 attach 的沙箱越级参数（`sandbox_permissions`/`justification`）实测**只越沙箱、不越策略**。
- `bash` / `pwsh`：审批走 `decideShell` 三档；后台执行本轮关闭（`config: { enableRunInBackground: false }`，理由见下方收口裁定）。

**收口裁定（2026-10-12，经隔离实例验证后定稿）：后台任务本轮不做，`run_in_background` 参数同步关闭。**

隔离验证事实（`vd` 变体：翻回 `tool-fs`/`tool-fs-search`/`tool-bash` + 额外翻 `jobs`/`tool-jobs`）：

1. **`jobs` / `tool-jobs` 两行是变体的硬锁定**——不是可配置项：`profile.ts` 的 launcher 补丁在机器级 patch 之后重放 `{ id: 'jobs', disabled: true }` / `{ id: 'tool-jobs', disabled: true }`（`profile.ts:1448-1449`），`HUAANWORK_ROW_ASSERTIONS` 对其断言 disable（`row-assertions.ts:19-20`）；即便在机器级 patch 里 `disabled: false`，组合结果仍是 disabled（`rows.mjs` 实测：`jobs=/tool-jobs=disabled:true`，同批的 `tool-fs`/`tool-bash=disabled:false`）。放开它们 = 改 M3 锁定层 + 行断言 + `profile.spec.ts` 的 disable 矩阵，属产品级决定。
2. **`run_in_background` 在无注册表时是"可见但必败"的能力**：full 档下实测模型调用 `bash {command:"sleep 30", run_in_background:true}` 得到
   `Error: background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`（`tool-bash/src/index.ts:503-506`），而该参数仍被广告在 schema 上（`:394`）。
3. **`tool-bash` 的 `enableRunInBackground: false` 是干净的回退**：schema 不再广告该参数，调用期仍强制拒绝（`:502-505` "Undeclared keys are allowed, so schema omission also needs enforcement"）。

**决定（按判据 C1/C2/C3：最小改动、契约诚实、独立可验证）**：
- 本轮复挂只翻 `tool-fs` / `tool-fs-search` / `tool-bash`（win 为 `tool-pwsh`），并给 `tool-bash` **显式配置 `enableRunInBackground: false`**——工具面只提供前台执行，模型看不到不能用参数；
- 后台任务（`jobs` + `tool-jobs` + `job_list`/`job_output`/`job_kill`）**移入范围外**，作为后续独立裁定（要动 M3 锁定层，需自己的论证）；`job-controller` 的 pending 保持现状（它等的是被锁的 `jobs`，属既有关闭集合，不新增噪音）；
- 既有事实登记：full 档下 `nohup`/`&` 已可让模型自管后台进程（隔离实测成功）——本轮不新增管理面，该既有旁路写入威胁模型。

### L3：huaanwork-web-tools（自建）

- `web_fetch`：URL → GET（超时 + 2MB 响应上限 + 重定向次数限制）；HTML 提取正文文本。门控：接线时注入 `checkNetwork()` 回调缝（读 `huaanwork-host/settings.ts` 的 `allow_network`，复用 `net-gate.ts` 的判定），纯逻辑包不碰宿主状态；`false` → 返回结构化错误「请先在 设置→权限 打开公网开关」。
- `screenshot`：playwright-core + `channel: "chrome"`（复用系统 Chrome，零下载，不内嵌 Chromium）；参数 url、viewport?、full_page?、waitMs?。无系统 Chrome 时返回明确错误指路。返回：image 内容块（**实施验证项**：`ImageBlock` 需要 attachment 服务的 `ImageAttachmentRef`，要确认工具侧可达该服务；不可达则只走路径兜底）+ PNG 落盘 `<workspace>/.huaanwork/screenshots/` 并返回路径（模型不支持视觉时用户可自行查看）。
- policy 新增 case：`web_fetch`、`screenshot` 均 ALLOW（出网由 `allow_network` 总闸负责，工具层不再 ask，避免每次抓取都弹审批）。

## policy 增量汇总

`packages/huaanwork-policy/src/decide.ts` 本轮只新增 **2 条 case**（均为 L3，全部 ALLOW）：`web_fetch`、`screenshot`。无任何既有 case 的行为变更。原稿的 `list_dir` / `task_output` / `task_kill` 三条随 L1/L2 复挂一并撤回——`list_dir` 上游无此工具；后台任务控制工具（上游 `job_list`/`job_output`/`job_kill`）本轮不出现（`jobs`/`tool-jobs` 保持硬锁定，见 L2b 收口裁定），若未来解锁则落 `decide()` 的 `default` 分支另行评估，本轮不新增 case、也不改 `present-as.ts` 白名单。（2026-10-12 复核订正：修订稿原句「`ALLOWED_TOOLS` 需为 `job_*` 放行」与 L2b「保持关闭」裁定矛盾，予以撤回。）

## 错误处理

统一沿用 policy 的「面向模型的可执行建议」文案风格：错误文本说明原因 + 下一步动作（如 REASON_PATH_ESCAPE 已确立的格式）。L1/L2 的拒绝文案由既有 policy 层给出（越界路径、元字符解析限制、待审批等），本轮不改文案；L3 自建工具的执行失败（Chrome 缺失、网络关闭、响应超限）均返回结构化错误而非抛出未处理异常。

## 测试策略

- **L1/L2（复挂，无新逻辑包）**：不写工具单测（上游自带测试）；本变体补的是**行断言与端到端行为钉**——`profile.spec.ts` / `HUAANWORK_ROW_ASSERTIONS` 断言 `tool-fs`/`tool-fs-search`/`tool-bash`(+`pwsh`) 处于 enable 且 `tool-bash` 的 `enableRunInBackground` 为 false、`jobs`/`tool-jobs` 保持 disabled；隔离实例回归沿用 spike 报告的三组实验（工具目录数量、越界 deny、`bash` ask/元字符 deny），并新增一条「`run_in_background` 不在 schema 中」的模型可见面钉。`packages/huaanwork-policy` 无需新增 case，故无新判定钉。
- **L3（自建）**：`packages/huaanwork-web-tools` 单测：注入 fetch/launch/checkNetwork 缝，同构 `huaanwork-git-tools` 的测试模式；门控用例覆盖三类目标（公网被拒 / 局域网放行 / `allow_network=true` 全放行）。
- `packages/huaanwork-policy/src/decide.test.ts` 补 2 条新 case（`web_fetch` / `screenshot`）的判定钉。
- guardrails 侧按 `git` 接线的既有 cordis 测试模式（`dsh-plugin-huaanwork/tests/huaanwork-guardrails/git.cordis.spec.ts`）补 `web` 接线测试。
- 验证命令走仓库完整门禁：`corepack yarn check`（含 test / typecheck / variants / layout / 各包 check），提交前另跑 `corepack yarn check:desktop-variants`。

## 范围外 / 延后项

| 项 | 处理方式 |
|---|---|
| web_search | 本轮不做；用户挂搜索类 MCP server（机制已存在）；若未来自建，参照 Open WebUI 收敛方案选 SearXNG |
| **后台任务**（`jobs` + `tool-jobs` + `job_*` 控制） | 本轮不做（`jobs`/`tool-jobs` 是变体 M3 硬锁定，放开需产品级裁定）；`tool-bash` 显式 `enableRunInBackground: false`，模型看不到 `run_in_background` 参数 |
| 完整浏览器控制（click/type/evaluate） | 不做；截图验证不足时另立项 |
| 截应用自身窗口 | 不做（需跨 Rust/进程边界） |
| 持久记忆 | 不属于工具面，未纳入本轮 |

## 威胁模型登记（2026-10-12 工具箱扩展）

1. **bash 出网旁路**：`allow_network` 总闸只管 web_fetch/screenshot/模型端点；`bash` 执行的命令（如 curl）不受其门控，由 `decideShell` 三档护栏负责（full 档下 curl 直接放行，ask/smart 档弹审批或按元字符规则拒绝）。
2. **write/edit 沙箱越级参数**：上游 tool-fs 在 `fs-sandbox`(workspace-write) 下给 write/edit 展开 `sandbox_permissions`/`justification` 参数；实测只能越过沙箱、越不过 huaanwork-policy 的 pre-execute 判定（spike §4.5），deny 即终局。
3. **nohup/& 自管后台**：后台任务管理面本轮不开放（jobs/tool-jobs 硬锁定），但 full 档下模型可用 `nohup … &` 自管后台进程（spike §4.6 实测），产物无管理面可回收；开放 job_* 管理面是后续独立裁定。
4. **链路本地元数据地址**：`isLanEndpoint` 把整段 `169.254.0.0/16`（含 `169.254.169.254`）和 `*.local` 视为局域网。`allow_network=off` 时 `web_fetch` / `screenshot` 仍放行这些地址。这是复用模型端点谓词的结果，本轮不改谓词；云主机上 agent 因此可以 GET 实例元数据服务。

## 实施验证项（动手时先确认）

1. `screenshot` 的返回形态：确认工具侧能拿到 attachment 服务并构造 `ImageBlock`（需要 `ImageAttachmentRef`，不是裸 base64；上游 `browser-use-stagehand-native` README 有同形做法可参照）—— 不可达则只走 PNG 路径兜底。
2. `playwright-core` 新增依赖的落位：确认它进入 `dsh-plugin-huaanwork` 的依赖面并通过 `verify:licenses` / `runtime-closure` / 打包清单（这是本轮唯一的新运行时依赖）。
3. playwright-core `channel: "chrome"` 在目标内网机器（macOS/Windows）的可用性 —— 无 Chrome 时的错误文案兜底已设计。
4. 新包接入步骤：`huaanwork-web-tools` 按 `huaanwork-git-tools` 的 package.json/tsconfig 同形复制，并同步根 `package.json` 的 `workspaces`/`test`/`typecheck` 链、`scripts/expected-root-gate-scripts.json`、`verify-layout.mjs`、`market-dependency-direction` 检查面与 beta/stable 的 `tests/package.spec.ts` 包清单。
5. `tool-bash` 的配置覆盖要**整块给全**：`{ disabled: false, config: { enableRunInBackground: false } }`——机器级 patch 的 config 是整块替换（spike §4.2 的 ValidationError 教训），且 `disabled: false` 与 config 必须同一条 patch 里落，否则会回到 web-app overlay 的 `disabled: true` 状态。

**已由 spike 关闭的旧验证项**：`fs.glob` 可用性（Node 22.19+ 已 stable；且复挂路线根本不用它）、`defineTool` 是否支持 image 块（类型面确认是 `ContentBlock[]`，问题在 attachment 引用而非渲染支持）、配置覆盖语义（整块替换，`required` 字段必须给全）。
