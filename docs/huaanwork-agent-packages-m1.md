# 智能体包 M1 使用与排障（runbook）

> **状态：Windows 探针已接线，第一次 GHA 运行未通过。job 退出码 0 之前不得记为 PASS。**
>
> - macOS 真机验收：`PASS（代理驱动实机验收）`。2026-10-24 裁定：Task 9 Step 4 采用代理驱动的真实 macOS 应用 + 真实模型证据，见 `docs/evidence/2026-10-23-agent-package-macos-acceptance.md`；真人交互复核列为可选/独立项，不再是 M1 阻断项。
> - Windows：绿跑之后的标签是 `PASS（GHA Windows 探针）`。GitHub Actions `windows-latest` 上的 workflow **Windows agent package acceptance**（job `windows-agent-package-acceptance`）退出码 0，才满足 Step 5。覆盖沙箱 `enforcement:partial`、读/网络观察、HTTP/MCP 在 `afterIdle` 后停止，以及 Host 退出钩子跑完后 `Get-CimInstance Win32_Process` 不再有 `agents\<slug>\`。这不是 GUI 真机，也不覆盖访谈、确认卡或真实模型 `@slug`；那些保持可选，不阻断。
> - 2026-10-24 第一次 `workflow_dispatch` 未通过：[run 40057259357](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40057259357)，checkout `81769a1b8d`，退出码 3。沙箱事实与 HTTP/MCP `afterIdle` 通过。`hostExit` 在进程查询摘要只留下 `matches` 之后读取 `residuals.length`，探针崩溃，阶段记为未开始。这不是残留进程，也不是 PASS。
> - 该 job 只在 `workflow_dispatch` 时运行，不挂在每次 push/PR 的产品 CI 上。单元测试、typecheck、变体守卫和 `corepack yarn check` 仍只证明代码与装配。升成产品门禁的做法见 §11，且不得放宽现有门禁。
> - 运行 URL 与探针结论记在 `docs/evidence/2026-10-24-agent-package-windows-gha-acceptance.md`。退出码不是 0 的运行不写成 PASS。
>
> 两项验收的可执行清单见 §11。验收记录模板见 §12。

## 1. M1 范围：只做本地创建、运行与启停

M1 **只**包含：会话内创建、本机智能体包、AgentsView 三页签、`@slug` 运行、启用/关闭、旧目录（catalog-legacy）条目兼容。

M1 **不包含**发布、签名、下载、安装、广场更新、下架、撤销。这些是 M2（设计规格 §8），当前代码与界面均未接线。

- 「我的智能体」与「智能体广场」没有“发布 / 下载 / 安装 / 移除”按钮。
- 智能体包没有 `.signature/`；`agents-state.json` 只写 `local:` 条目；没有 `publishStatus` / `publishedVersion` 字段。
- 智能体包相关 RPC 只有 `agent.packageList`、`agent.packageDetail`、`agent.packageSetEnabled`、`agent.invocableList`。没有 publish / install / revoke 路由。
- `agents-enabled.json` 只保留旧目录启用键；M1 不把旧条目下载或物化成包。

验证方法见 §10。

## 2. 文件位置

`{profileDir}` 是当前 Profile 目录。默认 Profile 名为 `desktop`：

| 平台 | 默认 Profile 目录 |
| --- | --- |
| macOS / Linux | `~/.huaanwork/profiles/desktop` |
| Windows | `%USERPROFILE%\.huaanwork\profiles\desktop` |

若首启时改过数据目录，或设置了 `DSH_HOME`，以实际 DSH home 下的 `profiles/<名称>` 为准。应用日志里的 `DSH_HOME` 行会打印实际位置。

| 内容 | 位置 |
| --- | --- |
| 智能体包 | `{profileDir}/agents/<slug>/` |
| manifest | `{profileDir}/agents/<slug>/agent.json` |
| 人设 | `{profileDir}/agents/<slug>/persona.md` |
| 技能 | `{profileDir}/agents/<slug>/skill/SKILL.md` |
| 技能脚本 | `{profileDir}/agents/<slug>/skill/scripts/**` |
| HTTP 入口 | `{profileDir}/agents/<slug>/tools/http/server.mjs`（`tools` 含 `http` 时必有） |
| MCP 入口 | `{profileDir}/agents/<slug>/tools/mcp/server.mjs`（`tools` 含 `mcp` 时必有） |
| 未确认草稿 | `{profileDir}/agents/.drafts/<sessionId>.json` |
| 本地包启用态 | `{profileDir}/agents-state.json`（只写 `local:<slug>`） |
| 旧目录启用态 | `{profileDir}/agents-enabled.json`（旧路径独占读写，键形如 `catalog:<name>`） |
| 旧本地工具入口 | `{profileDir}/agents-endpoints.json`（归「我的工具包」，不属于智能体包） |

## 3. 创建、更新、启停与运行

### 3.1 创建（会话内访谈）

1. 在会话输入以下任一入口：
   - `帮我新建一个智能体`
   - `帮我建一个数字员工，专门写周报`
   - `新建智能体` / `创建智能体`
   - `/create-agent`（可带一句初始描述）
2. 助手按固定顺序逐问：用途 → 显示名与 `@` 标识 → 能力简介 → 人设边界 → 技能包 → 工具选择。
3. 助手调用 `agent_propose` 后，会话出现确认卡（标题「请确认是否创建这名智能体」），并列出：显示名、`@` 标识、能力简介、人设要点、技能包、工具。
4. 用户**在下一轮**回复同意原句（去首尾空白、去掉结尾一个 `。！!？?` 后整句等于）：
   - `可以`
   - `确认`
   - `同意`
   - `就这样`
   - `按这个建`
5. 宿主写入 `{profileDir}/agents/<slug>/`，新包**默认关闭**；`agents-state.json` 写 `local:<slug>`，`enabled:false`。
6. 打开「智能体」→「我的智能体」，卡片显示显示名、能力简介、`@slug`、版本与「本地创建」。

拒绝写入的情况：同一轮刚 propose 就 commit、用户原句不是同意说法、`draftId` 不匹配、没有待确认草稿。

### 3.2 更新

1. 在会话输入 `/create-agent update <slug>`（例：`/create-agent update weekly-report`）。卡片上的更新提示也是这条命令。
2. 只描述要改的字段；宿主以现有包为 base 合并，未提交字段保持不变。
3. 回复同意原句提交。版本 patch +1，**原有启用态保持不变**。
4. M1 不支持改 slug（更新提案里提交 `slug` 会被拒绝）；要换标识请新建后关闭旧包。

### 3.3 启用、关闭与运行

- **启用**：「我的智能体」→ 卡片「启用」。本地包写入 `agents-state.json` 的 `local:<slug>.enabled=true`；旧目录条目写 `agents-enabled.json` 的 `catalog:<name>: true`（§6）。
- **关闭**：同一卡片「关闭」。本地包写入 `local:<slug>.enabled=false`；旧目录条目删除 `agents-enabled.json` 的 `catalog:<name>` 键（§6、§13）。
- **运行**：会话输入 `@<slug> <任务>`（例：`@weekly-report 汇总本周进展`）。只有已启用且未损坏的包会进入 `@` 补全。
- **进程生命周期**：每个 `@` 回合独立拉起 HTTP/MCP/脚本子进程，回合空闲（`afterIdle`）后停止；不跨轮常驻。关闭卡片只阻止**后续** `@`，不会杀掉已经在进行的回合；该回合同样在空闲后停止。`afterIdle` 最多等子会话 10 分钟（HTTP/MCP 长回合可能晚于父回合的空闲点）；超时记一条错误、释放 activation 并照常停止子进程。
- **同会话并发**：同一会话同时只允许一个包智能体回合。第二个 `@` 会被拒绝，提示当前会话已有运行中的智能体包回合；等第一轮结束再发起。

### 3.4 取消与草稿

- 有草稿时回复 `取消` 或 `先不要`：宿主丢弃草稿、不写入包，并回复「已取消创建，没有写入智能体。」
- 草稿只保留最近一份；再次 propose 会覆盖同一会话的草稿。
- 手工清理：退出应用后删除 `{profileDir}/agents/.drafts/<sessionId>.json`。

## 4. 字段与大小上限

| 项 | 限制 |
| --- | --- |
| `slug` | 匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，1–32 字符；不得与本地包、旧目录智能体/工具、本地工具入口重名 |
| `displayName` | 去首尾空白后 1–40 个 UTF-16 码元；可重复 |
| `description` | 去首尾空白后 1–200 个 UTF-16 码元 |
| `version` | semver；新建写 `1.0.0`，同 slug 更新 patch +1 |
| `draftId` | 宿主生成的 UUID；≤128 字符；仅用于 commit 幂等核对 |
| `persona.md` | 非空 UTF-8，≤32 KiB |
| `skill/SKILL.md` | ≤32 KiB；frontmatter `name` 必须等于 slug |
| 技能脚本数量 | ≤20 个 |
| 单个技能脚本 | ≤256 KiB |
| HTTP / MCP 入口文件 | 各 ≤256 KiB |
| 整包 | manifest + persona + skill + 脚本 + 工具入口合计 ≤5 MiB |
| 合并人设 | persona + SKILL.md + `allowSkills` 正文 + `## 工具` 段合计 ≤64 KiB（propose 校验前三项；合成时连工具段一起计数，超限拒绝运行） |
| 脚本路径 | `^[A-Za-z0-9._/-]+$`，不含 `..`、不以 `/` 开头、不允许符号链接；必须位于 `skill/scripts/` |
| `tools.mode` | `none` / `http` / `mcp` / `both`；选中项必须有入口文件，未选中项不得有文件 |
| `argumentsSchema` | 可选；序列化后 ≤1024 字符 |
| `allowSkills` | 每项必须是当前可找到且已启用的技能；不能是 `create-agent` |
| `@` 运行参数 | `agent_http` 默认 60 秒、硬顶 150 秒；响应读入 ≤1 MiB；工具输出 ≤32 KiB |
| 技能脚本执行 | `agent_skill_run` 硬顶 150 秒；stdout ≤32 KiB；非 0 退出回传 stderr 前 500 字符 |
| 服务启动健康 | HTTP/MCP 5 秒内可连接；MCP 还须在预算内返回至少 1 个工具；端口冲突最多重试 3 次 |

## 5. 沙箱边界（原话）

创建确认卡上的原话：

> 脚本将在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。

详情页固定提示的原话：

> 脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。

含义：

- 沙箱使用现有 `sandbox-local` 后端与 `workspace-write` 策略，**只约束写**。
- **读取包外文件不受限制；网络访问不受限制。** 包来源审查（M2）不是运行时隔离。
- 沙箱不可用时 M1 **fail-closed**：报「当前系统无法启动沙箱，智能体未运行」，不会无沙箱运行。
- Windows 上沙箱自报 `enforcement:partial` 是已接受事实；GHA 探针必须记录该值及读/网络观察（§11 Step 5）。

能力声明与人设：

- `agent_http` 与 `agent_skill_run` 是**全局注册的工具**，工具描述固定、不带包级信息；模型靠合成人设里的 `## 工具` 段获知本包声明的技能脚本路径（`无` 表示没有脚本）与 HTTP `argumentsSchema`（未声明时省略该行）。
- 该段与 persona、SKILL.md、`allowSkills` 正文一起计入 64 KiB 人设上限；合成后超限时该回合拒绝启动。
- 工具段只是面向模型的声明：可执行范围仍由宿主按 `tools.mode` 与脚本声明拼出名单，再对子代理 `tools.restrict({ allow })`。

## 6. catalog-legacy 的含义

`catalog-legacy` 指旧公用机目录里尚未迁移为签名包的 persona 条目。M1 的兼容规则：

- 旧启用表 `agents-enabled.json` 中的 `catalog:<name>: true` 继续有效。
- 条目出现在「智能体广场」，也已启用的条目出现在「我的智能体」，来源徽标为「旧目录智能体」。
- 启用/关闭走 `agent.packageSetEnabled`，写旧 `agents-enabled.json`：启用写 `catalog:<name>: true`，关闭**删除**该键；**不写** `agents-state.json`。
- M1 不下载、不复制、不物化、不伪造签名包：`agents/<name>/` 不会因为旧条目出现而被创建。
- `@<name>` 仍走旧 `kind:"agent"` 路径，不进入包运行时，也不参与发布。
- 目录不可达时：保留上次已知列表与旧启用态，界面显示 `catalogError` 横幅；不会因为离线把已启用项隐藏或关掉。目录恢复后同一 `catalog:<name>` 键继续生效。

## 7. 常见错误与处置

| 错误文案（原话） | 含义 | 处置 |
| --- | --- | --- |
| `当前系统无法启动沙箱，智能体未运行` | 沙箱服务缺失，或 `confine` 报 `SANDBOX_UNAVAILABLE` | 不要绕过沙箱。检查系统沙箱后端/权限；M1 按设计拒绝运行 |
| `智能体 @<slug> 与现有智能体或本地工具重名` | slug 与旧目录智能体、工具或本地工具入口冲突 | 换一个 slug；到「我的工具包」/广场确认占用名 |
| `智能体 @<slug> 已存在` | `agents/<slug>/` 已存在（含损坏包） | 用 `/create-agent update <slug>` 更新，或换 slug |
| `智能体 @标识「<slug>」无效` | slug 不符合命名规则或超长 | 改成小写字母、数字与连字符，≤32 字符 |
| `脚本启动失败：<stderr 前 500 字符>` | HTTP/MCP 进程提前退出、端口不可用或启动即崩 | 检查入口脚本能否用 Node 直接启动、是否读取 `AGENT_HTTP_PORT`/`AGENT_MCP_PORT`、stderr 原因 |
| `脚本启动失败：MCP 服务挂载超时` | MCP 服务 5 秒内未完成挂载 | 缩短 MCP 启动；确认服务实现 `/mcp` 且能返回工具 |
| `MCP 服务「<name>」未提供任何工具` | MCP 服务挂载成功但工具数为 0（自定义挂载回调可能报 `MCP 服务未提供任何工具`） | 至少暴露一个工具；否则本轮失败并停进程 |
| 其他 MCP 启动/握手错误（非超时，原话由 MCP 客户端决定） | MCP 服务初始化或 handshake 失败 | 查看 Host 日志中该服务的初始化/stderr；确认入口在 5 秒内完成 streamable-http 握手 |
| `智能体 @<slug> 没有可运行的技能脚本` | 包未声明 `skill/scripts/**` 却调用 `agent_skill_run` | 在包里加入脚本并重新提交更新 |
| `未声明的技能脚本：<path>` | 模型传了声明集合之外的路径 | 只调用 `skill/scripts/` 下已落盘的脚本 |
| `智能体「<slug>」已损坏：<原因>`（`@` 运行）/ `智能体 @<slug> 已损坏:<原因>`（启用或 `/create-agent update`，原话为半角冒号） | manifest/人设/技能/入口文件缺失或与 `tools.mode` 不一致 | 按原因补齐文件，或重新创建/更新；损坏包禁止启用与运行，但已启用的损坏包仍可关闭 |
| `用户原句不是同意创建的说法` | commit 时用户原句不在同意短语表内 | 下一轮只回复 `可以` / `确认` / `同意` / `就这样` / `按这个建` |
| `同一轮里刚提出草稿，不能立即提交；请等下一轮用户确认` | 同一轮 propose 后立刻 commit | 等下一轮用户回复同意 |
| `本轮不是创建/继续创建流程，不能提交草稿` | 技能/@ 轮或其他非创建回合里模型调用了 `agent_commit` | 回到创建/继续创建的回合回复同意；不要用技能/@ 轮的原文提交旧草稿 |
| `没有待确认的草稿` | 草稿已被提交/取消或不存在 | 重新走创建/更新流程 |
| `公用机目录请求失败: <原因>` / `公用机响应状态错误: <status>` | 旧目录不可达或配置错误 | 检查设置里的公用机 host/port/token；旧启用态会保留 |

## 8. 日志位置

`{userData}`：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/HuaAnWork` |
| Windows | `%APPDATA%\HuaAnWork` |

| 日志 | 位置与命名 |
| --- | --- |
| Electron 主进程 | `{userData}/logs/dsh-YYYY-MM-DD.log`；错误另写 `dsh-YYYY-MM-DD.error.log` |
| Desktop Host（utility process） | `{userData}/logs/host/dsh-YYYY-MM-DD.log` 与 `.error.log` |
| 轮转 | 单文件 10 MiB；按日期与大小分段（`.1.log`、`.2.log`…）；目录上限 200 MiB。Electron 主进程启动时另清理 7 天前的自有日志；Host 日志只做大小轮转 |

说明：

- 智能体包的 HTTP/MCP/技能脚本 **stdout/stderr 不落盘**；成功输出只作为工具结果返回。失败时 stderr 前 500 字符进入工具错误（`agent_skill_run`）或「脚本启动失败：」文案，可在会话与 Host 日志中看到。
- 创建/更新被拒绝（字段错误、未同意、slug 冲突）以工具错误或界面提示返回；这些业务拒绝不保证写入日志。
- 需要完整诊断时用应用的诊断导出（若版本提供），或直接查看上述 `logs/` 与 `logs/host/`。

## 9. 清理残留 `.tmp-*` / `.old-*`

### 9.1 自动清理（正常情况）

- 每次读包路径（列表、详情、启停）都会幂等执行恢复：
  - 删除 `agents/.tmp-*`；
  - 若 `agents/<slug>/` 已存在，删除对应 `agents/.old-<slug>-<随机>/`；
  - 若 `agents/<slug>/` 缺失而 `.old-<slug>-<随机>/` 存在，把旧目录改回正式目录（回滚中断的更新）。
- 因此正常退出/崩溃后通常无需手工清理；重启应用打开一次「我的智能体」即可触发。

### 9.2 手工清理（仅在确认应用已退出后）

先退出应用，再执行。**不要**在正式目录 `agents/<slug>/` 缺失时删除对应的 `.old-*`，那是唯一的旧副本，应留给下次启动恢复。

macOS / Linux（bash）：

```bash
PROFILE="$HOME/.huaanwork/profiles/desktop"
# 删除临时目录
for d in "$PROFILE"/agents/.tmp-*; do [ -d "$d" ] && rm -rf "$d"; done
# 只删除正式目录已存在的旧副本
for d in "$PROFILE"/agents/.old-*; do
  [ -d "$d" ] || continue
  name=${d##*/.old-}
  slug=${name%-*}
  [ -d "$PROFILE/agents/$slug" ] && rm -rf "$d"
done
```

Windows PowerShell：

```powershell
$profileDir = "$env:USERPROFILE\.huaanwork\profiles\desktop"
Get-ChildItem "$profileDir\agents" -Directory -Filter '.tmp-*' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Get-ChildItem "$profileDir\agents" -Directory -Filter '.old-*' -ErrorAction SilentlyContinue | ForEach-Object {
  $slug = $_.Name -replace '^\.old-', '' -replace '-[0-9a-f]{12}$', ''
  if (Test-Path "$profileDir\agents\$slug") { Remove-Item $_.FullName -Recurse -Force }
}
```

清理后重启应用，确认「我的智能体」仍能列出包；若某个包消失，检查是否误删了唯一副本。

### 9.3 崩溃后的子进程

正常退出由宿主统一停止所有包运行时。若应用被强杀，可能残留监听回环端口的 Node 子进程：

- macOS / Linux：`ps aux | grep 'agents/<slug>/'`，确认后 `kill <pid>`。
- Windows：`Get-CimInstance Win32_Process | Where-Object CommandLine -like '*agents\<slug>\*'`，确认后 `Stop-Process -Id <pid>`。
- 不要按端口盲杀其他进程；先核对命令行里的 `agents/<slug>/` 路径。

## 10. 如何验证 M1 不包含发布 / 下载 / 安装 / 撤销

按以下四层检查，任一出现发布面都说明超范围：

1. **界面**：「我的智能体」卡片只有「查看详情 / 启用 / 关闭」与更新提示；「智能体广场」只有「查看详情 / 启用 / 关闭」。没有「发布」「下载」「安装」「移除」「申请下架」「撤销」。
2. **磁盘**：`{profileDir}/agents/<slug>/` 下没有 `.signature/`；`agent.json` 与 `agents-state.json` 没有 `publishStatus`、`publishedVersion`、`source:"catalog"` 等 M2 字段。M1 新建包的 `source` 是 `local`。
3. **接口**：`grep -n "agent.package" dsh-plugin-huaanwork/src/huaanwork-host/routes.ts` 只应命中 `agent.packageList`、`agent.packageDetail`、`agent.packageSetEnabled`、`agent.invocableList`。没有 publish / install / download / revoke 路由。
4. **网络**：M1 只读取设置里配置的旧公用机目录（`GET /v1/catalog`、`GET /v1/catalog/<name>`）；没有向目录服务提交包、下载包或拉取撤销列表。

设计规格 §8 的签名、目录包、管理员 CLI、三 token、撤销只作为 M2 设计保留，不进入 M1 实现。

## 11. 真机验收清单

### Step 4（macOS，`PASS（代理驱动实机验收；真人复核可选）`）

2026-10-24 裁定：本项以代理驱动的真实 macOS 应用 + 真实模型证据收口，证据见
`docs/evidence/2026-10-23-agent-package-macos-acceptance.md`。下列清单保留给真人复核时复用，
不再是 M1 阻断项。

在一台 macOS 真机上，使用**非生产 profile / 测试工作区**执行：

- [ ] 说“帮我新建一个智能体”并完成访谈（用途 → 名称与 `@` → 简介 → 人设 → 技能 → 工具）。
- [ ] 回复同意，确认后「我的智能体」出现卡片，且默认关闭。
- [ ] 启用卡片。
- [ ] `@<slug>` 运行，确认人设与 SKILL 生效。
- [ ] 创建一个带 HTTP 的 fixture 智能体（可将 `dsh-plugin-huaanwork/tests/fixtures/agent-package/tools/http/server.mjs` 的内容作为 `httpServer` 提交）。
- [ ] `@` 调用 `agent_http`，确认返回 fixture 的回显结果。
- [ ] 关闭该卡片；确认后续 `@` 不再启动，并确认回合结束后没有残留进程（`ps aux | grep 'agents/<slug>/'` 为空）。
- [ ] `/create-agent update <slug>` 更新版本，确认 patch +1 且启用态保持。
- [ ] 重启应用，确认卡片、启用态与版本仍存在。
- [ ] 旧 catalog-legacy 条目在「我的智能体」可见且可关闭；关闭后 `agents-enabled.json` 的 `catalog:<name>` 键消失，`agents/<name>/` 仍不存在。

### Step 5（Windows，尚未 PASS；绿跑后记为 `PASS（GHA Windows 探针）`；GUI 与真实模型可选）

硬失败面由 workflow **Windows agent package acceptance** 执行（`.github/workflows/windows-agent-package-acceptance.yml`）。它只在 `workflow_dispatch` 时运行。退出码 0 是本步通过；退出码 1 是观察与预期不符；退出码 3 是探针未能开始（BLOCKED，不能当成通过）；退出码 2 是用法错误（含在非 Windows 上把结果标成 win32）。

- 沙箱探针 `node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-sandbox-probe.mjs --platform win32` 的 JSON：`enforcement` 为 `partial`，且 `httpReady`、`writeDenied`、`readOutside`、`networkOutside` 均为 `true`。读工作区外与访问公网成功是已接受事实（沙箱只限制写）。
- HTTP fixture 走 `createAgentPackageHost().dispatch().afterIdle()`。`afterIdle` 之后端口关闭，且 `Get-CimInstance Win32_Process` 中不再有 `agents\<slug>\`。
- MCP fixture 同样走 `afterIdle`。握手使用 `tests/fixtures/agent-package` 的 JSON-RPC（`initialize` 与 `tools/list`），经注入客户端完成。不启动打包的 MCP 客户端，也不挂模型会话。
- Host 退出：子进程调用插件卸载时使用的 `stopAllAgentPackageProcesses()`，等它结束并退出后，同一条 CIM 查询不再有 `agents\<slug>\`，HTTP/MCP 端口也不再接受连接。产品卸载回调本身不 await 该调用；探针会等它结束再查询。这不是 Electron GUI 退出。
- 若仍有残留，探针可以 `taskkill` 清理 runner。该动作只写入报告，不改变退出码。残留本身是硬失败。

触发：GitHub → Actions → **Windows agent package acceptance** → Run workflow → 选择含该 workflow 的分支。可选输入 `run_host_liveness` 默认关闭。打开后会先构建包，再跑 `yarn workspace dsh-plugin-huaanwork test:host-liveness-win`。那不是 Step 5：它要编出 `lib/desktop-cli.js`，并等待约 60 秒的挂起 Host。产品 CI 的 `desktop-windows` 已经在打包检查之后跑同一条测试。

本地自检（不替代 Windows job）：

```bash
node --test dsh-plugin-huaanwork/scripts/huaanwork-host-windows-acceptance.spec.mjs
node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-windows-acceptance.mjs --platform darwin
```

第二条必须是退出码 2。在非 Windows 上对 `--platform win32` 同样是退出码 2。

升成产品门禁（写入证据文件的 1–2 次绿跑之后，且不得放宽现有门禁）：

1. 把该 job 移入 `.github/workflows/ci.yml`，条件为 `needs.changes.outputs.product == 'true'`；或给本 workflow 加上 `pull_request` / `push`，并套用同一「仅产品变更才跑」条件。
2. 不要加 `continue-on-error`。不要从 `yarn check`、`desktop-windows` 或 `test:host-liveness-win` 删步骤。
3. 把检查名 `windows-agent-package-acceptance` 列为 required 之前，证据文件里要有 1–2 个退出码 0 的 run URL。
4. 升格后，GUI 访谈、确认卡和真实模型 `@slug` 仍然不在这个 job 里。

下列 GUI 清单保留给可选复核，不再是 M1 阻断项。本探针明确不做：会话访谈、确认卡、真实模型上的 `@slug`。

- [ ] 说“帮我新建一个智能体”并完成访谈。
- [ ] 回复同意，确认后「我的智能体」出现卡片，且默认关闭。
- [ ] 启用卡片，用真实模型 `@<slug>` 运行。
- [ ] 关闭卡片；确认后续 `@` 不再启动。
- [ ] `/create-agent update <slug>` 更新版本。
- [ ] 重启应用，确认卡片、启用态与版本仍存在。
- [ ] 旧 catalog-legacy 条目可关闭。

## 12. 验收记录

每次真机验收至少记录：

- 日期、机器（型号/OS 版本）、应用版本与构建来源（commit/artifact）。
- 使用的 Profile 路径与工作区路径（不要使用生产 profile）。
- 每项清单的通过/失败、截图或终端输出。
- Windows 的 `enforcement` 值与读/网络观察。
- 进程清理证据（命令与输出）。
- 任何偏离本 runbook 的现象。

当前记录：macOS `PASS（代理驱动实机验收）`，证据见
`docs/evidence/2026-10-23-agent-package-macos-acceptance.md`。Windows 第一次 GHA
dispatch 未通过（[run 40057259357](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40057259357)，退出码 3），不得记为 PASS。证据见
`docs/evidence/2026-10-24-agent-package-windows-gha-acceptance.md`。

## 13. 已知限制与差异

- 同一会话只允许一个包智能体回合；第二个 `@` 被拒绝而不是排队。
- 关闭卡片不会中断进行中的回合；回合同样在空闲后停止进程。
- 包运行时每轮拉起、空闲停止，不跨轮复用进程。
- 技能脚本无跨轮状态；本轮状态目录 `AGENT_STATE_DIR` 在回合结束删除，持久结果需写入当前工作区。
- catalog-legacy 只兼容旧启用键，不迁移成签名包；M1 不自动清理、批量删除或迁移旧键。关闭一个已启用条目会删除它的 `catalog:<name>` 键（§11），这是关闭动作本身，不是迁移。
- 沙箱只限制写；读与网络不隔离。Windows 的 `enforcement:partial` 是已接受事实。
- M1 不包含发布、签名、下载、安装、广场更新、下架、撤销（§1）。
