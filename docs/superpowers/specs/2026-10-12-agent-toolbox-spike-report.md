# 复挂可行性 spike 验证报告（agent 工具面）

**日期**: 2026-10-12
**类型**: 一次性 spike（不落地仓库改动；隔离实例 + 临时 DSH_HOME）
**关联**: `2026-10-12-agent-toolbox-design.md`（本报告的结论直接影响该设计的组织方式裁定）
**状态**: 三项验证目标全部完成，附一条未验证项

> **第二轮补跑（2026-10-12 晚）已并入 §4**：preset 路径在本变体**不参与工具供给**（会话 `agentPreset` 恒为 `null`，standard 预设独有工具不出现），有效路径只有 host 平面复挂。结论见 §4.4。

## 结论摘要

| # | 验证目标 | 结论 | 证据 |
|---|---|---|---|
| ① | agent 是否真拿到 read/glob/grep/bash | **是**。隔离实例的 agent 工具目录 = **12 个**（原 6 git + `read`/`write`/`edit`/`glob`/`grep`/`bash`） | 隔离会话 `request/header`（见 §3.2） |
| ② | 既有 policy 的 deny/ask 是否如期生效 | **是，且零新策略代码**。越界 read/write → deny（沿用 `REASON_PATH_ESCAPE` 中文文案）；`bash curl` → ask；工作区内 read → allow 并返回带行号内容 | §3.3 tool/result 逐条 |
| ③ | 多了哪些不想要的工具行 | 工具名层面**只有预期的 6 个新工具**（`read_image` 被 `present-as.ts` 白名单过滤掉）；但**未激活行**多了一条 `job-controller`（pending，等 `jobs` 服务），落在既有关闭集合内 | §3.4 |

**对设计的影响（最重要）**：目录里 6 个上游工具 + `read_image` 过滤 + `bash` 走既有 `decideShell` 三档，说明"自建四个纯逻辑包"并非唯一路径——**上游 `tool-fs` / `tool-fs-search` / `tool-bash` 已具备设计所需的全部能力，且与既有 policy 判定天然对齐**。设计文档的裁定 5（组织方式 A：一包一域四个新包）需要重新裁定；至少要把"为何不复挂上游工具"写成显式理由。web 侧不受影响（`tool-web` 依赖 `web` 服务，该服务不在本变体；截图仍须自建）。

## 1. 机制发现（静态事实，已复核）

上游工具不是"不存在"，而是"已挂载、被预设门禁关掉"：

- `@deepseek-ai/dsh-base/cordis.patch.yml:267-290` 挂载 `tool-bash`/`tool-pwsh`（平台门控）、`tool-fs`、`tool-fs-search`。
- `@deepseek-ai/dsh-web-app/cordis.patch.yml:468-491` 在 host 平面把上述四行 `disabled: true`；`:573` 再关 `tool-web`。
- `@deepseek-ai/dsh-web-app/presets/standard.patch.yml:28-46` 在 **preset 作用域**把同一批行装回去（外加 `tool-jobs`/`tool-schedule`/plan 等）。
- 本变体从不选 preset（`profile.ts:1445` 只配 `tools: { mode: 'native' }`），host 平面工具又被 overlay 关掉 ⇒ 只剩 6 个 git 工具（与真实会话记录一致）。

本轮 spike 的做法 = **机器级 patch**（`$DSH_HOME/cordis.patch.yml`，正是产品改 disable/enable 的那一层），把三行翻回 `disabled: false`，未触碰仓库任何文件。

## 2. 隔离实验设置

```
临时家目录   /tmp/huaanwork-spike/home        （DSH_HOME）
临时 userData  /tmp/huaanwork-spike/userdata    （--user-data-dir，避开单实例锁与真实数据）
启动命令      DSH_HOME=/tmp/huaanwork-spike/home \
              Electron ./lib/main.js --user-data-dir=/tmp/huaanwork-spike/userdata \
              --remote-debugging-port=9223
机器级 patch  home/cordis.patch.yml:
                - id: tool-fs        { disabled: false }
                - id: tool-fs-search { disabled: false }
                - id: tool-bash      { disabled: false }
```

- 只从真实 profile 拷贝三个状态文件（`huaanwork-settings.json` / `auth-session.json` / `account.json`），并按 `setup-wizard-state.ts` 的 hash 规则写入 wizard `skipped` 标记，避免Setup 向导。
- 驱动方式：CDP 连到隔离实例页面 → 走页面内 `fetch('/huaanwork/session/...')`（与 GUI 同一条 host 路由）。
- 全程未修改仓库文件、未触碰 `~/.huaanwork` 真实数据；实验后进程已停。

## 3. 运行时证据

### 3.1 启动自检

`app.log`：仅两条 pending 警告，均在既有预期关闭集内——

```
web-fetch-http (@deepseek-ai/dsh-web-fetch-http): pending (waiting for service: web)
job-controller  (@deepseek-ai/dsh-api-job-controller): pending (waiting for service: jobs)
```

注意：`job-controller` 这条是**复挂带来的新未激活行**（`tool-jobs`/`jobs` 被本变体有意关闭）。若走复挂路线，实施清单需要显式处理它（关闭或接受 pending 噪音）。

### 3.2 工具目录（验证目标①）

隔离会话 `request/header` 实测：

```
12 tools: bash, edit, git_branch, git_checkout, git_commit, git_diff,
          git_push, git_status, glob, grep, read, write
```

- 新增 6 个 = 预期集合，无意外泄漏。
- `read_image`（`tool-fs` 同包提供）**未出现**——被 `present-as.ts:6-26` 的 `ALLOWED_TOOLS` 白名单自然过滤，证明既有附件面护栏仍在生效。
- 模型侧自述的工具清单与 header 一致（模型回答里还逐条列出了工具用途）。

### 3.3 policy 三层判定（验证目标②）

驱动 agent 主动调用三类工具，`tool/result` 逐条：

| 调用 | 结果 | 判定层 |
|---|---|---|
| `read {file_path:"/etc/passwd"}` | `Error: huaanwork-policy: 路径越出当前工作区：仅允许访问工作区目录内的文件` | deny（`REASON_PATH_ESCAPE`，`decide.ts:78-80`） |
| `write {file_path:"/tmp/huaanwork-escape.txt"}` | 同上 | deny（forWrite 路径检查，`decide.ts:84-86`） |
| `bash {command:"curl -s https://example.com"}` | `tool "bash" requires approval, but no approval channel is available` | ask（`isHighRiskShell` 命中 curl，`decide.ts:185-188`） |
| `read {file_path:"inside.txt"}`（工作区内） | 放行，返回 `<content> 1: spike-marker-42`（带行号） | allow |

要点：

- 三档判定的 deny/allow 方向全部**无需新增任何策略代码**即生效，且文案就是既有面向模型的中文整改建议。
- `bash` 的 ask 是**预期行为**；"no approval channel available" 是因为本次用 HTTP 路由驱动（GUI 会话会弹审批框），不是缺陷。
- 附带发现：`bash` 在 ask/smart 档只拦"弹审批"，而 **`web_fetch` 的 `allow_network` 总闸管不到 bash 出网**（`full` 档 curl 直接放行）——设计文档若采用复挂路线，这条出网旁路需要写进威胁模型。

### 3.4 额外暴露面（验证目标③）

- **工具名**：0 个意外项（`read_image` 被过滤，`job_*`/`skill`/`schedule` 等 preset 侧工具未出现）。
- **未激活行**：+1（`job-controller`，见 §3.1 与上方说明）。
- 说明：`tool-fs`/`tool-fs-search` 依赖的 `fs-sandbox`/`sandbox-policy`（`workspace-write`）本就启用，复挂后直接接管写边界；`read` 返回内容里可见 `<path>/<type>/<content>` 结构化格式，与 policy 的 `resolveInside` 收拢是两层独立防护。

## 4. 补跑实验（第二轮，2026-10-12）：preset 路径是否可用

§4 原列三项未验证项，用同一隔离骨架补跑（换机器级 patch，不改任何仓库文件）。**结论：三项里两项被证伪、一项转为明确收口项——本变体里 preset 路径根本不参与工具供给，"复挂"只有 host 平面一条路。**

### 4.1 实验 A：纯基线（无任何 patch）

| 观测 | 结果 |
|---|---|
| agent 工具目录 | **6 个 git 工具**（与真实环境一致） |
| 会话 `agentPreset` 投影 | `null` |
| 启动日志 | 仅 2 条既有 pending（`web-fetch-http` / `job-controller`） |

对照第一轮（仅加 host 平面三行 patch）：**6 → 12**。工具数变化完全由 host 平面 patch 解释。

### 4.2 实验 B：显式选中 `standard` 预设

第一轮尝试用 `selectedDefault: ptc` 覆盖注册表配置，**整行失效**——这是本轮最有价值的机制发现之一：

```
agent-preset-registry (@deepseek-ai/dsh-agent-preset-registry): ValidationError: invalid config:
preset-standard (@deepseek-ai/dsh-agent-preset): pending (waiting for service: agentPresets)
preset-ptc / preset-minimal / preset-cordis: pending (waiting for service: agentPresets)
```

**原因**：机器级 patch 的 `config` 是**整块替换**而非字段合并。`agent-preset-registry` 的 schema 是 `{ default: required, selectedDefault: volatile }`（`agent-preset-registry/src/index.ts:55-58`），只给 `selectedDefault` 会让 `required` 的 `default` 缺失 ⇒ 注册表行不激活 ⇒ 四个 preset 行全部 pending。

修正为完整配置（`default: standard` + `selectedDefault: standard`）后重跑：

| 观测 | 结果 |
|---|---|
| 注册表行 | 正常激活（无 ValidationError） |
| 新建会话 + 发消息 | `agentPreset` 投影仍为 **`null`** |
| 工具目录 | **6 个 git 工具**（standard 预设未贡献任何工具） |
| 启动 pending | 仅既有 2 条 |

### 4.3 实验 B2：preset 配置 + host 平面 patch 叠加

| 观测 | 结果 |
|---|---|
| 工具目录 | **仍是 12 个**，且**只有** `read/write/edit/glob/grep/bash` 这 6 个新工具 |
| `todo_write` / `skill` / `schedule_*` 等 standard 预设独有工具 | **未出现** |
| 会话 `agentPreset` 投影 | **`null`** |
| 模型侧自述 | 与 `request/header` 一致（12 个） |

### 4.4 结论（裁定 5 重开的依据）

1. **本变体里 preset 路径不参与工具供给**：会话 `agentPreset` 恒为 `null`，preset 独有工具在任何配置下都不出现。宿主侧四个 preset 行虽然存在，但对 agent 工具面无实际贡献。
2. **"preset standard 可能整棵激活失败"这一风险无需再担心**——它对本变体的工具面无影响；同时也意味着**寄希望于"只改 preset 配置就能拿到工具"不可行**。
3. **复挂的唯一有效路径 = host 平面（机器级/配置层）把 `tool-fs`/`tool-fs-search`/`tool-bash` 三行翻回**，成本 3 行配置 + 逐项收口清单（见下）。
4. **收口项**（选择 host 平面复挂时必须一并处理）：
   - `job-controller`：因 `jobs` 被关闭而 pending，需接受或显式关闭；
   - `tool-jobs` / `tool-schedule` 等 preset 侧行：不在 host 平面复挂范围内，无需处理；
   - `read_image`：已被 `present-as.ts` 白名单过滤（本轮两次实测均未出现），无需额外处理；
   - 若后续上游把 `tool-fs` 等行改回默认启用，本变体的 disable 清单需同步。

### 4.5 实验 C：复挂后 `write` 的沙箱越级参数能否突破策略

复挂 `tool-fs` 会连带启用它自带的「沙箱越级提权」API（`tool-fs/src/sandbox.ts`：`FsSandboxController` 在 `ctx.fs.sandboxMode` 存在时给 `write`/`edit` 展开 `sandbox_permissions`/`justification` 两个参数）。这是复挂路线独有的新增攻击面，必须实测：

| 观测 | 结果 |
|---|---|
| `write` 的实收参数 | `['content', 'file_path', 'justification', 'sandbox_permissions']` —— **提权字段确实被广告**（与本变体的 `fs-sandbox`(workspace-write) 一致） |
| 工作区内写 `note.txt` | 放行，返回 `<content>Created file</content>` |
| 越级写 `/tmp/…` 且带 `sandbox_permissions:"danger-full-access"` + `justification` | **deny**：`huaanwork-policy: 路径越出当前工作区…` —— 与不带提权字段的普通越界写**文案完全一致** |
| `bash` 复合命令（含 `;`） | **deny**：`REASON_SHELL_METACHAR`（元字符解析限制，ask 档） |

**结论**：上游的越级提权 API **只能越过沙箱，不能越过策略**——`huaanwork-policy` 的 pre-execute 判定先于工具执行，deny 即终局；即便策略改为 ask，弹的也是 huaanwork 既有审批通道（GUI 可控）。复挂路线的这一新增面是**可控的**，且行为可预测。

### 4.6 实验 D：后台任务（`jobs` + `tool-jobs`）能否复挂

变体 D = 实验 C 的三行 + 额外把 `jobs`、`tool-jobs` 翻回 `disabled: false`（机器级 patch）。`guard_mode=full` 以绕过审批通道限制。

| 观测 | 结果 |
|---|---|
| 组合后的行状态（`prepareDesktopProfile` + `composeEntries` 直读） | `jobs = disabled:true`、`tool-jobs = disabled:true`、`job-controller = enabled` —— **与同批的 `tool-fs`/`tool-bash`（`disabled:false`）形成对照** |
| 原因 | `profile.ts:1448-1449` 的 launcher 补丁在机器级 patch **之后**重放 `{ id: 'jobs' \| 'tool-jobs', disabled: true }`；`row-assertions.ts:19-20` 对其断言 disable ⇒ **不是可配置项，是变体硬锁定** |
| 启动日志 | `job-controller (@deepseek-ai/dsh-api-job-controller): pending (waiting for service: jobs)` 保持 |
| 强制模型调用 `bash {command:"sleep 30", run_in_background:true}` | `Error: background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`（`tool-bash/src/index.ts:503-506`），而该参数仍被广告在 schema（`:394`）⇒ **"可见但必败"** |
| 对照：模型自发的 `nohup … &` 变通（full 档） | 成功执行且进程存活至自然退出（自管后台，无管理面） |

**结论**：① `jobs`/`tool-jobs` 的开放要动 M3 锁定层 + 行断言 + `profile.spec.ts` 矩阵，属产品级裁定，不是配置翻行；② 只翻 `tool-bash` 会留下一个模型可见但必败的参数；③ 干净回退 = `tool-bash` 配置 `enableRunInBackground: false`（schema 不再广告该参数，调用期仍强制拒绝，`tool-bash/src/index.ts:502-505`）。**本设计据此把后台任务移入范围外**，见设计文档 L1/L2 收口裁定。

### 4.7 仍未验证（低优先，实施时顺带确认）

1. **present-as `restrict` 与 preset 作用域注册的交互**：既然 preset 不贡献工具，此问对当前路线不适用；仅在未来上游把工具改成 preset 供给时需要重验。
2. **`bash` 出网旁路**的最终处置（是接受为威胁模型条目，还是在 `isHardDenyShell` 加例外）——属策略决策，不是验证项。
3. **带提权字段的越界写在 GUI 会话中的审批表现**：本轮用 HTTP 路由驱动，实测为策略 deny；GUI 下若策略档位改为 ask，需确认弹框文案不再展示"已批准"假象。

### 4.8 依赖与许可面（实验 C 附带确认）

| 项 | 事实 |
|---|---|
| 许可 | `tool-fs` / `tool-fs-search` / `tool-bash` 均为 **MIT** |
| 新增运行时依赖 | `tool-fs` + `diff@^9`；`tool-fs-search` + `@vscode/ripgrep@^1.18`（仓库已有 resolutions 补丁与锁文件条目）；`tool-bash` 无新增 |
| 复挂后 tool 目录 | 12 个，仅有预期的 6 个新工具（`read_image` 由 `present-as.ts` 白名单挡住） |

## 5. 对设计文档的处置建议

1. **裁定 5 已按本报告定稿（三层结论）**：L1+L2 复挂、L2b 后台任务不做（§4.6 的硬锁定结论）、L3 自建。落地清单、触发回转条件见 `2026-10-12-agent-toolbox-ab-criteria.md`；**preset 路径已证不可用（§4.1-4.4），勿再作为备选**。
2. **`read` 与 `str_replace_editor` 的重合**：上游 `dsh-tool-str-replace-editor` 与 `tool-fs` 的 `edit` 是不同工具；设计文档只列了 `edit`。复挂时要注意 `tool-fs` 注册的是 `read/write/edit` 还是含 `read_image`（已证实 `read_image` 被本变体白名单挡住）。
3. **`list_dir` 无需新增 policy case**（本轮已复核 `pathsAreInside` 的 `allowMissing` 语义）；且复挂路线下 `list_dir` 上游无此工具，该条已随 L1/L2 一并从设计文档撤回。
4. **出网旁路**（§3.3 末）写进威胁模型。
5. 设计文档"实施验证项 2（fs.glob 可用性）"可以关闭：Node 22.19+ 上 `fs.glob` 是 stable，仓库 engines 地板已满足。
6. **配置覆盖语义**（§4.2 的机制发现）：机器级/profile patch 里对任何行做 `config:` 覆盖都是**整块替换**，`required` 字段必须一并给全。这条应写进实施注意事项，避免踩 `ValidationError` 使整行静默失效。
7. **A/B 路线判据**已另稿：`2026-10-12-agent-toolbox-ab-criteria.md`（三层表、落地清单、触发回转条件）。核心依据 = §4.1-4.4（preset 路径不可用）、§4.5（提权 API 越不过策略）、§4.6（后台任务硬锁定与回退）、§4.8（依赖/许可面）。

## 附：证据文件位置（临时，非仓库）

- 第一轮隔离会话档案：`/tmp/huaanwork-spike/home/sessions/--tmp-huaanwork-spike-home-profiles-desktop-workspace--/huaanwork-e73d034fe860c1eb/session.v4.jsonl.zstd`（含 `request/header` 12 工具清单、四条 tool/result）
- 第二轮实验 A（基线 6 工具）：`/tmp/huaanwork-spike/va-home/sessions/.../huaanwork-566e50b4f350b61e/`
- 第二轮实验 B2（12 工具、preset 无贡献）：`/tmp/huaanwork-spike/vb-home/sessions/.../huaanwork-8d2cfb83297e0fd0-c8224ff7/`；启动日志 `/tmp/huaanwork-spike/vb3.log`
- 第二轮实验 B（config 覆盖失效证据）：`/tmp/huaanwork-spike/vb.log` 的 `ValidationError` 行
- 第三轮实验 C（提权参数实测）：`/tmp/huaanwork-spike/vc-home/sessions/.../huaanwork-1b5dafa88ea3eb9e/`；启动日志 `/tmp/huaanwork-spike/vc.log`
- 第三轮实验 D（后台任务/硬锁定）：行状态直读脚本 `/tmp/huaanwork-spike/rows.mjs`；会话 `/tmp/huaanwork-spike/vd-home/sessions/.../huaanwork-1c563e44de90ac73-013fbc23/`；启动日志 `/tmp/huaanwork-spike/vd.log`、`vd2.log`
- 各变体机器级 patch：`/tmp/huaanwork-spike/{home,va-home,vb-home,vc-home,vd-home}/cordis.patch.yml`
- 真实侧对照（6 工具基线）：`~/.huaanwork/sessions/.../session.v4.jsonl.zstd` 各会话 `request/header`
