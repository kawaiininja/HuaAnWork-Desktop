# 逐 step 工具看板 — 真机验收（2026-11-09）

- 分支：`feat/per-step-tool-board`，验收时 HEAD `7001f3a8a3`（Task 8 收尾；Task 9 之前无源码改动）
- 计划：`docs/superpowers/plans/2026-11-09-per-step-tool-board.md` Task 9
- 设计：`docs/superpowers/specs/2026-11-09-per-step-tool-board-design.md` §10（A1–A10）
- 环境：macOS（darwin-arm64）、Electron 44.0.0、Node `v22.23.2`、Yarn `4.18.0`（经 Corepack）
- 前置：`corepack yarn workspace dsh-plugin-huaanwork build` → exit 0；`corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native` → exit 0（`fs-ext 2.1.1 for Electron 44.0.0 … ABI 149`）。根 `check` 链首步即 `build`，故 `lib/` 含 Task 1–7 全部改动。
- 未触碰 `deepseek-harness/`；未在生产 dev 实例上运行

## 1. 隔离实例参数

| 项 | 值 |
| --- | --- |
| 临时根 | `$(mktemp -d "${TMPDIR:-/tmp}/huaanwork-per-step-accept.XXXXXX")`，`chmod 700`（实测 `drwx------`） |
| `DSH_HOME` | `$TMP_ROOT/.huaanwork`（整树复制生产 home 后清空 `sessions/` 下其他真实会话，只放入本地化夹具） |
| `--user-data-dir` | `$TMP_ROOT/userData`（`profile-selection/state.json` 复制自生产，`active=desktop`） |
| 调试端口 | `--remote-debugging-port=9333`（启动前空闲；清理后复查无监听） |
| 验收钩子 | `HUAANWORK_ACCEPTANCE_HOOKS=1` |
| 启动命令 | `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS DSH_HOME=… HUAANWORK_ACCEPTANCE_HOOKS=1 <repo>/dsh-plugin-huaanwork/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <repo>/dsh-plugin-huaanwork/lib/main.js --user-data-dir=… --remote-debugging-port=9333` |
| 客户端 origin | `http://127.0.0.1:43120/?dsh-desktop-mode=advanced&…`（默认口 43120，未占用顺延；驱动按调试端口的 `127.0.0.1` 页面自动发现，未传 `--origin`） |
| 驱动 | `dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs`（CDP：`Runtime.evaluate` + `Page.captureScreenshot`，通用退避等待） |

## 2. 夹具来源与本地化

源会话：`huaanwork-21ea5abce4b51784-b6617067`，物理路径 `~/.huaanwork/sessions/--Users-amonmiao-.huaanwork-profiles-desktop-workspace-sessions-huaanwork-21ea5abce4b51784-b6617067--/huaanwork-21ea5abce4b51784-b6617067/session.v4.jsonl.zstd`（89 个 zstd 帧，237 201 B），header `cwd = /Users/amonmiao/.huaanwork/profiles/desktop/workspace-sessions/huaanwork-21ea5abce4b51784-b6617067`。Step 1 时刻重算源日志：**21 step / 66 `tool/call` / 20 step 有调用 / 20 step 有 reasoning**，step 21 无工具，与设计 §1 取证一致（源会话此后未被续写）。

本地化（`huaanwork-localize-session-fixture.mjs`）：按宿主同一套派生算法改写为临时实例原生会话，事件行逐字保留。

| 结果字段 | 值 |
| --- | --- |
| `sessionId` | `huaanwork-0e842e87a074fae2-b6617067`（临时 workspace 稳定前缀 + 原 `b6617067` 后缀） |
| `mintedRoot` | `$TMP_ROOT/.huaanwork/profiles/desktop/workspace-sessions/huaanwork-0e842e87a074fae2-b6617067` |
| `storagePath` | `$TMP_ROOT/.huaanwork/sessions/<projectKey(mintedRoot)>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd` |
| `eventLines` | `212`（= 源日志 213 行减去 header 行；回读逐行比对通过） |

本地化后最近列表条目 `title` 为 `调研一下黑卡8的传言信息\nhuaanwork-0e842e87a074fae2-b6617067`，详情头部 `ID`、时间段与 `cwd` 均为临时根 ⇒ cwd 守卫与 `assertStoredIdentity` 均通过（设计 §1 的「只读错误视图」形态未出现）。

### 与计划脚本的偏差：帧布局（必须修的一处）

计划给出的本地化脚本用单次 `zstd -f` 压缩整份文本，产物是**一个** zstd 帧。上游读取器 `session-persistence-jsonl` 的 `assertZstdHeaderFrame`（`packages/session/session-persistence-jsonl/src/index.ts:77-82`）要求**首个帧独立可解且恰为一行 header**，实测该单帧产物被拒绝：

```
session "huaanwork-0e842e87a074fae2-b6617067": stored log is corrupt: Error: corrupt Zstandard session log: first frame is not exactly one header line
```

界面随之停在 `detail-meta` 只读错误视图（`.tool-panel`/`.thinking-panel` 均 0），与计划 A3 注记的「只读错误视图」现象同形但**根因不是 cwd 守卫**（`fixture.json` 的 `sessionId`/`storagePath` 与最近列表条目一致）。

修法：脚本改为按帧写入——第 1 帧只含 header 行（含行尾换行），第 2 帧含其余全部事件行（以行边界结束），两帧拼接后原子 rename 到 `storagePath`；回读自校验（行数、header 改写、逐行逐字比对）原样保留。修后 `zstd --list` 报 `Frames = 2`，会话正常打开。此偏差只改物理编码方式，**事件行内容与 A3 判据数字不受影响**。脚本仍在写入前拒绝 `--home` 指向真实 `~/.huaanwork`（实测 `exit=1`，报错 `refusing to write into the production home`）；另对 `--suffix` 增加保守字符集校验（`^[A-Za-z0-9._-]+$`，拒绝 `.`/`..`），避免路径分隔符让铸造根逃出临时 profile —— 原守卫只拒绝精确的真实 home 路径，挡不住 `../..` 形态。

## 3. A1–A10 判定总表

| 编号 | 判据（设计 §10） | 方式 | 结果 | 证据指针 |
| --- | --- | --- | --- | --- |
| A1 | 看板数 = 产生普通 `tool` 条目的 step 数，位置随会话流推进；有效 `todo_write` 不计入 | 真机 CDP + 磁盘日志对账 | **PASS**（干净一次运行；另一次运行遇到护栏拦截调用的既有可见性差异，见 §4.1；本次运行未产生 `todo_write`，见 §5） | `a1b.json`（3 看板 / 1 思考）、`a1b.png`、日志派生 4 step / 3 有调用 / 1 有 reasoning |
| A2 | 无普通工具的 step 不产出看板，前后看板不合并 | 真机 CDP + 单测 | **BLOCKED**（夹层形态三次尝试未出现；「无工具 step 不产出看板」一档已实测） | `a2.json`（11 step / 5 看板）、`a2b.json`（3 step / 2 看板）、`a2c.json`（两轮 2 看板）；单测 `toolPanel.spec.ts:507` |
| A3 | 重开 `b6617067`：20 看板（step 1–20 有工具、step 21 无工具）+ 20 思考面板，无顶部聚合，`todo_write` 入板 | 真机 CDP | **PASS** | `a3.json`、`a3.png` |
| A4 | 两条消息各自有工具 → 看板按消息归属，互不混用 | 真机 + 单测 | **PASS**（归属）；差量见 §4.1 | `a4-msg1.json`、`a4.json`、`a4.png` |
| A5 | 思考面板数 = 有 reasoning 的 step 数；下一轮无 reasoning 有正文时，上一轮思考不误标「已生成」 | 真机 CDP + 单测 | **PASS** | `a1b.json`（1 = 1）、思考标题实测 `思考 · 进行中`（非「已生成」） |
| A6 | 降级推断：`final=true` 仍按正文切轮；混合键旧前缀推断、新 key 精确 | 单测 | **UNIT-ONLY** | `toolPanel.spec.ts:603`「final turns still split rounds by visible body when no roundKey exists」、`:618`「mixed keys infer the unkeyed prefix and keep explicit keyed rounds exact」 |
| A7 | 展开第 3 轮看板后切标签再回来仍展开，其余轮次不受影响 | 真机 CDP | **PASS** | `a7-2-toggle.json`（`expanded[2]="true"`）→ `a7-3-newtask.json` → `a7-4-reopen.json`（`expanded[2]` 仍 `"true"`，其余 19 项仍 `"false"`） |
| A8 | 取消 / 失败 / 正常结束后无手动覆盖的看板默认收起；状态按真实终态，仅未结算调用允许「已中断」 | 真机 CDP | **PASS** | `a8b.json`（1 看板，`expanded="false"`，`工具 · 含失败调用 · 1 项调用`）、`a8b.png` |
| A9 | `sidecarDead` 时在途工具显示「状态未确认」，不计入运行中 | 单测（既有覆盖不回归） | **UNIT-ONLY** | `toolPanel.spec.ts:108`「connection loss demotes only unresolved running tools without rewriting facts」 |
| A10 | `corepack yarn check` exit 0 | 命令 | **PASS**（引用 Task 8 结果，未重跑） | Task 8：`exit=0`，日志 `/tmp/per-step-tool-board-check.log`（2405 行 / 160 576 B）；`git diff fd710a8865..HEAD` 仅 1 个文档文件 |

## 4. 逐项证据

### 4.1 A1 / A5 实时运行与日志对账

驱动命令（两次运行，均为新任务）：

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs \
  --action=send --prompt='请使用 bash 依次执行 pwd、ls、uname -a，并汇总输出。' \
  --out="$TMP_ROOT/evidence/a1.png" > "$TMP_ROOT/evidence/a1.json"
```

运行 1（计划提示原文）：facts `panelCount=3`、`thinkingCount=2`、`counts=[1,1,1]`、`panelRowIndexes=[3,4,5]`。磁盘日志派生 5 step：step 1–4 各有 1 次 `tool/call`、step 5 无；reasoning 出现在 step 1、2。

差量 1 个看板已定位到成因：step 1 的调用是 `pwd; echo "---"; ls; …`，被护栏拒绝（`tool/result` `isError=true`，`Error: huaanwork-policy: 命令含 shell 元字符…`）。护栏走 `ctx.tools.guard`（`huaanwork-guardrails/policy.ts:114`）与 `tools/pre-execute`，而客户端的 `tool/start` 只在 `tools/execute` 中间件里发出（`huaanwork-guardrails/bridge.ts:120-135`）⇒ 被拦截的调用**从来不会产生客户端工具条目**，因此不会有看板。这是里程碑之前就存在的可见性差异（旧「每用户回合一个面板」同样看不到它），不是逐 step 投影缺陷；但计划的对账口径按磁盘 `tool/call` 计数，遇到拦截调用必然出现差量，故本次以一次不含拦截调用的运行作为 A1 判据证据。

运行 2（改述提示，按允许的一次重试用掉）：`--prompt='请用三次单独的 bash 调用依次完成：第一次执行 pwd，第二次执行 ls，第三次执行 uname -a；每条命令单独一次调用，完成后汇总三条输出。'` → facts `panelCount=3`、`thinkingCount=1`、`counts=[1,1,1]`、`panelRowIndexes=[2,3,4]`、`expanded` 全 `false`。

同一会话磁盘日志派生（计划 Step 4 的计数片段原文运行）：

```
[{"seq":6,"turn":1,"step":1,"normalTools":1,"reasoning":1},
 {"seq":18,"turn":1,"step":2,"normalTools":1,"reasoning":0},
 {"seq":23,"turn":1,"step":3,"normalTools":1,"reasoning":0},
 {"seq":28,"turn":1,"step":4,"normalTools":0,"reasoning":0}]
```

对照：`panelCount 3 == normalTools>0 的 step 数 3`（逐 step 位置随会话流推进，`panelRowIndexes` 严格递增），`thinkingCount 1 == reasoning>0 的 step 数 1`，无工具 step（step 4）不产出看板。A1 **PASS**。

A5 第二判据实测：唯一有 reasoning 的 step 1 与最终 step 4 的可见正文**不同轮**，step 1 的思考标题为 `思考 · 进行中`（`ThinkingPanel.tsx:34` 对「无同轮正文」的展开态加后缀），**未被误标「已生成」**；运行 1 同样成立（2 个思考面板均非「已生成」，而最终 step 有正文）。轮次收窄生效，A5 **PASS**。

### 4.2 A2 无工具轮次（BLOCKED）

三次尝试（每次均为新任务；第二次与第三次分别是允许的「换措辞」与「补前置条件」）：

1. 计划提示原文 `先读取 package.json，然后只回答“收到”，再读取 tsconfig.json。`：临时会话根为空目录，模型转而反复探测工作区，日志派生 11 step / 10 step 有调用 / 1 step 只有正文（step 11），facts `panelCount=5`、`thinkingCount=11`。差量 5 个看板逐一对应 5 次被护栏拒绝的调用（step 1、4、6、7、9 的 `tool/result` 均为 `huaanwork-policy` 错误），与 §4.1 的既有可见性差异同源；夹层形态未出现（模型直接放弃并说明无法读取）。
2. 改述 `请先用 bash 执行 echo first，然后只回答“收到”且不要调用任何工具，最后再用 bash 执行 echo second。`：日志为 `[tool, tool, body]`——正文落在最后一步，工具之间没有无工具 step。
3. 补前置条件（先发一条纯正文消息建会话，再把 `package.json`/`tsconfig.json` 写进该会话铸造根，再发计划提示原文）：turn 2 为 `[2 调用, 2 调用, 只有正文]`，正文仍在末尾。

结论：**「无工具 step 不产出看板」一档已实测成立**（运行 1 的 step 11、A2 第三次的 turn 2 step 3、A1 运行 2 的 step 4 均无看板），但**「夹在两次工具之间」的形态三次都未出现**，因此「前后看板不合并」这一档在真机上未取得证据。按计划要求标 **BLOCKED**，不以下列单测冒充真机：`tests/client-huaanwork/toolPanel.spec.ts:507`「a step without tools produces no panel and does not merge its neighbours」（本次重跑该文件 33/33 通过）。

### 4.3 A3 历史夹具（PASS）

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs \
  --action=open-history --session-id=huaanwork-0e842e87a074fae2-b6617067 \
  --out="$TMP_ROOT/evidence/a3.png" > "$TMP_ROOT/evidence/a3.json"
```

facts：`panelCount=20`、`thinkingCount=20`、`counts=[1,4,5,5,5,6,6,1,1,1,1,5,1,5,4,4,5,4,1,1]`（合计 **66**）、`panelRowIndexes=[4,5,7,9,11,13,16,18,20,22,24,26,28,30,32,34,37,39,41,43]`（严格递增）、单面板最大 6（**不存在 66 的聚合面板**）、`expanded` 20 项全为 `false`（历史终态默认收起）。

与判据逐条吻合：step 1 与 step 20 的 `todo_write` 在历史侧作为普通工具条目入板（各自 1 项调用），因此 20 个看板 / 66 次调用；step 21 无工具、无看板；20 个思考面板与源日志 20 个有 reasoning 的 step 一致。设计 A3 要求的「该历史夹具含 `todo_write` 入板、不作实时/历史数量相等断言」得到实测印证（实时侧同一步的 `todo_write` 会走待办卡）。A3 **PASS**。

### 4.4 A4 跨用户消息（PASS）

```bash
node … --action=send --prompt='请使用 bash 执行 pwd 并说明结果。'        # 消息 1（新任务）
node … --action=send --new=0 --prompt='再读取 tsconfig.json 并汇总。'     # 消息 2
```

（第二条消息前把 `tsconfig.json` 写入该会话铸造根，避免模型把工作区为空当成任务失败。）

DOM 行序（`a4.json` 的 `panelRowIndexes=[2,8,9]`，配合逐行类名快照）：

| 行 | 类型 | 内容 |
| --- | --- | --- |
| 0 | `bubble.user` | 消息 1 |
| 1 | `thinking-panel` | 消息 1 的思考 |
| 2 | `tool-panel` | `工具 · 已完成 · 1 项调用` |
| 3 | `bubble.assistant` | 消息 1 的正文 |
| 4 | `note` | 回合核对提示 |
| 5 | `bubble.user` | 消息 2 |
| 6–7 | `thinking-panel` | 消息 2 的思考 |
| 8–9 | `tool-panel` | 消息 2 的两个看板（各 1 项调用） |
| 10 | `thinking-panel` | `思考 · 已生成`（同轮有正文） |
| 11 | `bubble.assistant` | 消息 2 的正文 |

看板全部落在各自用户消息之后，没有跨消息混用或合并；消息 1 的 1 个看板对应 turn 1 的 1 个有工具 step（turn 1 还有一个只有正文的 step，未产出看板）。turn 2 日志派生 3 个有调用 step、界面 2 个看板，差量 1 个与 §4.1 的护栏拦截可见性差异同型（该 turn 的思考块明确写着护栏拦截了 shell 元字符），未把差量记作归属缺陷。归属判据 A4 **PASS**。

### 4.5 A7 手动展开归属（PASS）

```bash
node … --action=open-history --session-id="$FIXTURE_ID"
node … --action=toggle --index=2 --out=…/a7-2-toggle.png
node … --action=new-task
node … --action=open-history --session-id="$FIXTURE_ID" --out=…/a7-4-reopen.png
```

`a7-2-toggle.json`：`panelCount=20`、`thinkingCount=20`、`expanded[2]="true"`，其余 19 项 `"false"`，`counts` 与 `panelRowIndexes` 同 A3。

`a7-4-reopen.json`：`expanded[2]` 仍为 `"true"`，其余 19 项仍 `"false"`，`counts`、`panelRowIndexes` 与切换前逐项相同 ⇒ 手动展开归属在第 3 个面板（step 3，5 项调用）上，标签切换 + 幂等 resume 后未被重建、也没有扩散到其他轮次。A7 **PASS**。

#### 4.5.1 a7-1 旧会话误截与驱动就绪修复

首次 A7 的 `a7-1-open.json` 是**静默截错**：facts 与当时已打开的 A4 会话一致，不是夹具。驱动当时只等 `.tool-panel`/`.thinking-panel` 非空，上一次会话的既有内容即可满足；点击后 `session.open`/`session.resume` 尚未完成时旧 DOM 仍在，快照就被采信。

修法（`dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs`）：`--action=open-history` 的就绪判据改为**会话特定**——点击前从被点行 `title`（`${title}\n${sessionId}`）取出期望标题并记录点击前的 `.chat-log` 元素；点击后只在以下任一成立时采信：① 只读回退 `.session-detail-title` 的 `title` 恰为 `sessionId`；② `.chat-log` 已重挂载（或点击前显示的本就是本会话，同标签重复点击不重挂载），且首条用户消息按宿主同款空白折叠 + trim 后包含期望标题。不再以「任意看板非空」作为就绪。

复验（按 §1 重建隔离实例、本地化同一夹具，`--action=open-history` 连续两跑）：两跑均 `panelCount=20`、`thinkingCount=20`、`counts` 合计 **66**、`panelRowIndexes` 严格递增、`expanded` 20×false，且两跑 facts 逐项相同；第二跑正是从「夹具标签已打开」的状态起步。facts 备份：`/Users/amonmiao/huaanwork-per-step-tool-board-accept-evidence-2026-11-09-readiness/`（`open-history-run-1.json` / `open-history-run-2.json`，不进提交）。A7 判定不受影响：`a7-2-toggle`/`a7-4-reopen` 的 `expanded[2]` 与 `counts`/`panelRowIndexes` 已与 A3 夹具一致，说明后续步骤确实作用在夹具上；只有 `a7-1-open` 这一张快照是旧会话。

### 4.6 A8 取消后的收起与状态（PASS）

计划命令 `--action=stop --prompt='请使用 bash 连续执行 sleep 30 与 uname -a。'` 的首发会在 stop 按钮出现的那一拍停止，实测停在工具启动之前：`panelCount=0`、`thinkingCount=0`，界面只有 `bubble.user` 与 `note 已停止`，无可观察看板。

第二次尝试用同一提示词发送，运行中（面板已出现 `工具 · 执行中 · 1 项调用`）由 CDP 点击 `.send.stop`，随后取 facts：

```json
{"panelCount":1,"thinkingCount":2,"counts":[1],"panelRowIndexes":[4],
 "titles":["工具 · 含失败调用 · 1 项调用"],"expanded":["false"]}
```

- 看板类名 `tool-panel tool-panel-failed`、标题 `工具 · 含失败调用 · 1 项调用`、`aria-expanded="false"`：该面板没有手动覆盖，取消后保持收起。
- 状态取自真实终态：日志 step 2 的 `tool/result` 为 `isError=true`、`Error: tool call aborted`（调用已结算为失败），故显示「含失败调用」而非「已中断」；设计只允许**未结算**调用显示「已中断」。
- 两个思考面板标题均为 `思考 · 已中断`，与取消语义一致。
- 该 turn 的 step 1 同样是护栏拦截（`sleep 30 && uname -a`），按 §4.1 不产生看板。

A8 **PASS**。

### 4.7 A6 / A9（UNIT-ONLY）

两项在设计里本就标注为单测：A6 需去掉 `step/start` 的 fixture、A9 需 `sidecarDead` 注入，均非真机可达形态，本次不重复造真机场景，也不以真机口吻陈述。引用（本次重跑 `tests/client-huaanwork/toolPanel.spec.ts` → **33/33 通过**）：

- A6：`:603`「final turns still split rounds by visible body when no roundKey exists」、`:618`「mixed keys infer the unkeyed prefix and keep explicit keyed rounds exact」。
- A9：`:108`「connection loss demotes only unresolved running tools without rewriting facts」（既有覆盖，不回归）。

### 4.8 A10 全量门禁（引用，不重跑）

Task 8 命令原文 `corepack yarn check > /tmp/per-step-tool-board-check.log 2>&1; echo "exit=$?"` → **`exit=0`**，日志 `2405` 行 / `160 576` B（`wc -l` 实测；16:53–16:56 CST，单次运行通过）。Task 8 之后只有 `fd710a8865`、`7001f3a8a3` 两个文档提交（`git diff --stat fd710a8865..HEAD` 仅 `docs/evidence/2026-11-09-per-step-tool-board-gates.md` 5 增 1 改），源码未变，故引用有效，本次未重跑全量门禁。

## 5. 未跑项与限制

| 项 | 状态 | 原因 |
| --- | --- | --- |
| A2 夹层形态（工具 → 无工具 → 工具） | BLOCKED | 三次尝试（原提示 / 换措辞 / 补前置条件）模型都把「只回答收到」放到回合末尾；判据未改写 |
| A1 的「有效 `todo_write` 不计入」 | 未在本机行使 | A1 的提示与模型运行没有产生 `todo_write`，该档未在真机上触发。A3 覆盖历史侧 `todo_write` 入板（step 1/20 各 1 项），实时侧 `todo_write` 走待办卡、不产出工具看板是既有行为（非本里程碑改动）；不据此改写 A1 判定 |
| A6 / A9 | UNIT-ONLY | 需构造无 `step/start` 的 fixture 与 `sidecarDead` 注入，真机不可达；引用单测且本次重跑通过 |
| A10 | 引用 Task 8 | 此后无源码改动；不重复 3 分钟门禁 |
| A8 第二发的停止方式 | 非提交脚本可复现 | 第二发是在运行中用临时 CDP 点击 `.send.stop` 停止的，不是 `--action=stop`；该发不能从驱动复现，但 facts 与磁盘日志仍支持 A8 判定（停后看板收起、状态取自真实终态）。首发 `--action=stop` 的停点（停在工具之前）已记录 |
| Windows 侧真机 | 未跑 | 本次验收在 macOS 单机完成，与 Windows 打包/制品校验无关，未声称跨平台结论 |
| 护栏拦截调用的实时可见性 | 观察项（非本轮缺陷） | `ctx.tools.guard` / `tools/pre-execute` 拒绝的调用不会进入 `tools/execute`，客户端因此没有 `tool/start`，实时无看板；历史侧按日志仍会渲染成「含失败调用」面板。里程碑前既有行为，本次只记录其对「按磁盘 `tool/call` 对账」的影响 |
| `思考 · 进行中` 标签 | 观察项（非本轮缺陷） | 无同轮正文的思考面板在回合结束后仍显示「进行中」后缀（`ThinkingPanel.tsx:34` 的展开态后缀），A5 要求的「不误标已生成」正是该结果；未改文案 |

## 6. 证据备份与清理

- 本地备份（截图与 facts JSON，**不进提交**）：`/Users/amonmiao/huaanwork-per-step-accept-evidence-2026-11-09/`
  - `evidence/`：`a1`/`a1b`/`a2`/`a2b`/`a2c`/`a3`/`a4`/`a4-msg1`/`a7-1-open`/`a7-2-toggle`/`a7-3-newtask`/`a7-4-reopen`/`a8`/`a8b` 各 `.json` 与对应 `.png`（`.err` 均为空），另有 `a2-warmup.json`、`a2-newtask.json`
  - `fixture.json`：本地化脚本输出（`sessionId` / `storagePath` / `mintedRoot` / `eventLines` 212；其中路径指向已删除的临时根，保留为溯源记录）
- 就绪修复复验备份（同样**不进提交**）：`/Users/amonmiao/huaanwork-per-step-tool-board-accept-evidence-2026-11-09-readiness/`（`open-history-run-1.json` / `open-history-run-2.json` 及其截图、`fixture.json`；两跑 facts 逐项相同）
- 清理：basename 守卫（`huaanwork-per-step-accept.?*`）通过后执行 `cp -R` 归档 → `kill $(cat electron.pid)` → `rm -rf "$TMP_ROOT" /tmp/huaanwork-per-step-accept-root`。实测：临时根与指针文件均已删除，`pgrep -f huaanwork-per-step-accept` 无命中，`lsof -iTCP:9333` 无监听；`rm -rf` 未作用于任何 mktemp 根之外的路径。就绪修复复验按同一流程重建与清理，清理后同样复查：无实例进程、临时根与指针文件已删除、9333 无监听。
- 本文件与两个脚本是唯一提交内容；截图、`fixture.json` 与任何临时根副本都不 `git add`（`origin` 为公开仓库）。
