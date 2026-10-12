# Agent 工具箱扩展 设计文档

**日期**: 2026-10-12
**状态**: 用户已确认设计（范围、搜索后端、截图范围、组织方式、目标仓五项裁定均经逐项确认），待实施计划。

## 背景

HuaAnWork agent 当前工具面 = 6 个 Git 工具（`git_status` / `git_diff` / `git_branch` / `git_checkout` / `git_commit` / `git_push`，接线于 `HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/git.ts`，纯逻辑在 `HuaAnWork-Desktop/packages/huaanwork-git-tools/`）。agent 无法看代码、改代码、验证改动，工作闭环断裂。

**关键事实：护栏层已提前建好。** `HuaAnWork-Desktop/packages/huaanwork-policy/src/decide.ts` 的 `decide()` 已为 `read`/`read_file`（`:78-79`）、`glob`/`grep`（`:81-82`）、`edit`/`write`（`:84-85`）、`str_replace_editor`（`:87`）、`bash`/`pwsh`（`:95-96`）预留判定 case（含 `resolveInside` 路径收拢、`classifyShell`/`isHardDenyShell`/`isHighRiskShell` 命令分级、三档护栏模式 ask/smart/full）。本轮实施 = 补齐工具侧，让 policy 层的既有判定生效，**不重写策略**。

## 已确认的裁定（2026-10-12 澄清轮）

1. **范围**: 四个优先级一次做完（只读三件套、写+执行+后台任务、截图、web_fetch）。
2. **搜索后端**: **本轮只交付 web_fetch，不做 web_search**。调研结论：Kimi Work/Trae/Qoder 的搜索均为云厂商服务端工具，对本产品（本地 OpenAI 兼容模型，服务端无搜索能力可借）不成立；本地优先阵营（Open WebUI/LibreChat）已收敛为「fetch 本地实现 + 搜索可配置 provider（SearXNG 自托管事实标准）或不自建走 MCP」。本产品 MCP 挂载机制已存在（`huaanwork-guardrails/agent-mcp.ts` 的 `mountSessionMcp`），搜索需求由用户挂搜索类 MCP server 满足。
3. **web_fetch 门控**: 复用既有 `allow_network` 设置（`dsh-plugin-huaanwork/src/huaanwork-host/settings.ts`，配套 `net-gate.ts`）。`allow_network=true` 时 web_fetch 可调用；`false` 时不发请求，返回结构化错误提示用户先在 设置→权限 打开公网开关。
4. **截图范围**: 只做截图（URL → headless 渲染 → 图片），不做完整浏览器控制（click/type/evaluate），不截应用自身窗口。
5. **组织方式**: 方案 A（一包一域）——新增四个纯逻辑包 + guardrails 四个薄接线模块，沿用 `huaanwork-git-tools` 的「纯逻辑（依赖注入缝、可单测）+ Cordis 接线」双层模式。
6. **目标仓**（2026-10-12 写稿时发现并裁定）: 实施在 **HuaAnWork-Desktop**（新仓）。旧 Tauri 仓 `HuaAnWork` 已声明停维存档（README：「本版本已停止维护……继任者是 HuaAnWork Desktop」），新版同位置已有同构设施（`packages/huaanwork-git-tools`、`packages/huaanwork-policy` 同套预留 case、`huaanwork-host/net-gate.ts`）。本 spec 文档存放于新仓 `HuaAnWork-Desktop/docs/superpowers/specs/`（初稿曾按 M26 先例落在旧仓文档脊柱，用户裁定移至新仓）。

## 架构总览（均在 HuaAnWork-Desktop 内）

```
packages/
  huaanwork-fs-tools/       read / glob / grep / list_dir      （纯逻辑，零子进程）
  huaanwork-write-tools/    write / edit                        （纯逻辑）
  huaanwork-exec-tools/     bash（pwsh）+ 后台任务登记表         （纯逻辑 + spawn 缝）
  huaanwork-web-tools/      web_fetch / screenshot              （纯逻辑 + fetch/launch 缝）
dsh-plugin-huaanwork/src/huaanwork-guardrails/
  fs.ts / write.ts / exec.ts / web.ts   （薄接线，同 git.ts 模式；web.ts 注入 allow_network 读取缝）
```

命名对齐 policy 既有 case：`read`（非 `read_file`）、`glob`、`grep`、`write`、`edit`、`bash`/`pwsh`（按平台，`decideShell` 已强制）。

**新仓规则约束**（来自 HuaAnWork-Desktop CLAUDE.md）：
- zero-touch 规则：本轮只动 `dsh-plugin-huaanwork/` 与 `packages/huaanwork-*`，不碰 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`。
- variant 守卫：`src/huaanwork-guardrails/` 在 beta↔huaanwork 守卫的 6 条 oneSidedPrefixes 白名单内，新增接线文件零白名单成本；`packages/` 不在守卫覆盖面内。
- 提交前跑 `corepack yarn check:desktop-variants` 验证守卫仍绿。

## 各层设计

### huaanwork-fs-tools（只读，零副作用）

| 工具 | 参数 | 行为 |
|---|---|---|
| `read` | path, offset?, limit? | 带行号输出（cat -n 风格）；默认上限 2000 行；超长行截断；二进制文件返回明确说明文本而非乱码 |
| `glob` | pattern, path? | tinyglobby 遍历；默认排除 node_modules/.git；结果按 mtime 排序；路径须在工作区内 |
| `grep` | pattern, path?, glob?, ignoreCase?, maxResults? | 纯 JS 正则（不依赖 rg 二进制，内网机器未必有）；行号输出；结果数上限 |
| `list_dir` | path? | 目录列表，文件/目录类型标记 |

policy：`read`/`glob`/`grep` 已有 case（路径出区即 deny）；`list_dir` 需新增一条 ALLOW case（带 pathsAreInside 检查）。

### huaanwork-write-tools

- `write`：path + content 整文件覆盖。policy 已有 `edit`/`write` case（forWrite 路径检查）。
- `edit`：path + old_str + new_str 精确替换；old_str 不匹配或不唯一时返回面向模型的整改建议（复用 `REASON_STR_REPLACE` 文案：「请先 read 确认文件内容后重试」）。唯一性校验由工具自身在执行时完成（policy 的 `edit` case 只做路径检查，`str_replace_editor` 的预执行唯一性校验本案不接线）。

### huaanwork-exec-tools

- `bash`（Windows 注册为 `pwsh`）：参数 command（或 cmd，policy 已强制二选一）；cwd 锁定 workspaceRoot（新仓 Context 的 `huaanworkWorkspaceRoot` 是 `{current: string}` holder，接线时取 `.current`）；默认超时 120s、可配置上限；stdout/stderr 截断复用 `packages/huaanwork-policy/src/truncate.ts`。审批走既有 `decideShell` 三档（灾难性命令硬拒绝 / 元字符解析限制 / 高危清单 / 普通命令），零新增策略代码。
- 后台任务：`bash` 加 `run_in_background` 参数 → 立即返回 task_id；新增 `task_output(task_id)`（拉增量输出）、`task_kill(task_id)`（杀进程树）。进程登记表在宿主进程内存（环形缓冲），重启即清。
- policy 新增 case：`task_output`、`task_kill` 均 ALLOW（仅操作 agent 自起的后台进程，低风险）。

### huaanwork-web-tools

- `web_fetch`：URL → GET（超时 + 2MB 响应上限 + 重定向次数限制）；HTML 提取正文文本。门控：接线时注入 `checkNetwork()` 回调缝（读 `huaanwork-host/settings.ts` 的 `allow_network`，复用 `net-gate.ts` 的判定），纯逻辑包不碰宿主状态；`false` → 返回结构化错误「请先在 设置→权限 打开公网开关」。
- `screenshot`：playwright-core + `channel: "chrome"`（复用系统 Chrome，零下载，不内嵌 Chromium）；参数 url、viewport?、full_page?、waitMs?。无系统 Chrome 时返回明确错误指路。返回：image 内容块（**实施验证项**：确认 `defineTool` 的 output render 是否支持图片块；若不支持则只走路径兜底）+ PNG 落盘 `<workspace>/.huaanwork/screenshots/` 并返回路径（模型不支持视觉时用户可自行查看）。
- policy 新增 case：`web_fetch`、`screenshot` 均 ALLOW（出网由 `allow_network` 总闸负责，工具层不再 ask，避免每次抓取都弹审批）。

## policy 增量汇总

`packages/huaanwork-policy/src/decide.ts` 共新增 5 条 case，全部 ALLOW：`list_dir`（带 pathsAreInside）、`task_output`、`task_kill`、`web_fetch`、`screenshot`。无任何既有 case 的行为变更。

## 错误处理

统一沿用 policy 的「面向模型的可执行建议」文案风格：错误文本说明原因 + 下一步动作（如 REASON_PATH_ESCAPE / REASON_STR_REPLACE 已确立的格式）。工具执行失败（Chrome 缺失、网络关闭、命令不存在）均返回结构化错误而非抛出未处理异常。

## 测试策略

- 四个纯逻辑包各自单测：注入 run/fetch/launch/checkNetwork 缝，同构 `huaanwork-git-tools` 的测试模式。
- `packages/huaanwork-policy/src/decide.test.ts` 补 5 条新 case 的判定钉。
- guardrails 侧按 `git` 接线的既有 cordis 测试模式（`dsh-plugin-huaanwork/tests/huaanwork-guardrails/git.cordis.spec.ts`）补四个接线测试。
- 验证命令走新仓约定：`corepack yarn test` / `corepack yarn typecheck` / `corepack yarn check:desktop-variants`。

## 范围外 / 延后项

| 项 | 处理方式 |
|---|---|
| web_search | 本轮不做；用户挂搜索类 MCP server（机制已存在）；若未来自建，参照 Open WebUI 收敛方案选 SearXNG |
| 完整浏览器控制（click/type/evaluate） | 不做；截图验证不足时另立项 |
| 截应用自身窗口 | 不做（需跨 Rust/进程边界） |
| 持久记忆 | 不属于工具面，未纳入本轮 |

## 实施验证项（动手时先确认）

1. `defineTool`（`@deepseek-ai/dsh-tools`，新仓接线注释标注上游版本 0.1.6-alpha.2）的 output render 是否支持 image 内容块 —— 决定 screenshot 的返回形态。
2. Node 版本下 fs.glob 可用性 —— 若不可用则 glob 遍历用 tinyglobby（设计已按此假设）。
3. playwright-core `channel: "chrome"` 在目标内网机器（macOS/Windows）的可用性 —— 无 Chrome 时的错误文案兜底已设计。
4. 新仓 `packages/huaanwork-*` 的包管理约定（Yarn 4 workspaces + node-modules linker）下新增四个包的接入步骤 —— 实施计划阶段按 `huaanwork-git-tools` 的 package.json/tsconfig 同形复制。
