# A/B 路线判据：agent 工具箱的 fs / exec 工具从哪来

**日期**: 2026-10-12
**用途**: 为 `2026-10-12-agent-toolbox-design.md` 裁定 5（组织方式）提供可判定的选择依据
**依据**: `2026-10-12-agent-toolbox-spike-report.md`（§3 运行时证据、§4 补跑实验、§4.5 提权实测、§4.8 依赖面）

## 0. 判定原则：先把问题切成三层，再逐层选路线

"A 还是 B"不是全仓二选一。按实现面切成三层，每层独立判定——本轮 spike 的证据在三层上的结论并不相同：

| 层 | 工具 | 上游现成？ | 本 spike 结论 |
|---|---|---|---|
| L1 只读 + 写 | `read` / `glob` / `grep` / `write` / `edit` | 是（`tool-fs` + `tool-fs-search`） | **复挂**（B） |
| L2 执行 | `bash` / `pwsh`（前台） | 是（`tool-bash` / `tool-pwsh`） | **复挂**（B），`enableRunInBackground: false` |
| L2b 后台任务 | `run_in_background` + `job_*` | 是，但 `jobs`/`tool-jobs` 被变体**硬锁定** | **范围外**（解开需产品级裁定，见 §6） |
| L3 出网 | `web_fetch` / `screenshot` | 否（`tool-web` 依赖本变体没有的 `web` 服务） | **自建**（A） |

**所以最终路线 = L1+L2 复挂 + L2b 不做 + L3 自建**，而不是"A 或 B 二选一"。

## 1. 五条判据（按优先级）

### C1 策略/会话机制兼容性 —— 最高优先（不满足即否决自建）

**判据**：既有 `huaanwork-policy` 与 `present-as` 的工具名/参数契约，能否直接接管该工具？

| 事实 | 出处 |
|---|---|
| `decide()` 已按上游工具名预留 case：`read`/`read_file`、`glob`/`grep`、`edit`/`write`、`bash`/`pwsh` | `packages/huaanwork-policy/src/decide.ts:78-96` |
| `present-as.ts` 的 `ALLOWED_TOOLS` 已含上述全部名字 | `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:6-26` |
| 实跑验证：复挂后越界 deny / `bash` ask / 区内放行，**零策略改动** | spike 报告 §3.3 |
| 上游带提权字段的越界写仍被策略 deny（提权只能越沙箱、不能越策略） | spike 报告 §4.5 |

**结论**：契约完全对齐。自建在 C1 上没有额外收益；反而 B 的每个工具都被既有判定覆盖，无需新增 case。

### C2 行为可调性 —— 决定"自建理由"是否真实存在

**判据**：本产品要求的读/写/搜索行为，上游能否通过配置或适配层达到？不能，才是自建的真实理由。

- `tool-fs` 暴露四个读窗口旋钮：`readLimit`、`readMaxLineLength`、`readMaxBytes`、`readStreamMinSize`（含大文件流式读取阈值）——`tool-fs/src/index.ts:26-40`。
- `tool-fs-search` 的 `glob`/`grep` 走随包分发的 ripgrep，且是 `ctx.subprocess.spawn` 固定 argv（未暴露模型可写的 shell 层）。
- 复挂后实测：`read` 带行号输出、`glob` 6→12 工具、`read_image` 被白名单挡掉——行为与设计文档"只读三件套"目标一致（spike 报告 §3.2、§4.3）。

**结论**：目前**没有任何一条已确认的产品需求**要求偏离上游默认行为。若实施中发现真实需求（例如"必须屏蔽二进制内容"），优先走上游 Config 或与本变体沙箱/策略的组合，实测记录前不构成自建理由。

### C3 成本与依赖面 —— 决定性（差距是数量级）

**判据**：两条路线的工作量、依赖闭包、以及"以后要维护什么"。

| 面 | B（复挂 L1+L2） | A（自建四包） |
|---|---|---|
| 新增仓库包 | 0 | 4（`huaanwork-fs-tools` / `write-tools` / `exec-tools` / `web-tools`） |
| 新增运行时依赖 | `diff@^9`（tool-fs）、`@vscode/ripgrep@^1.18`（仓库已有 resolutions 补丁与锁条目） | 需自行引入 `tinyglobby` 或改用 `fs.glob`；搜索若走 rg 需自管二进制 |
| 实施改动 | 3 行 enable 配置 + 收口 `job-controller` pending + profile/row-assertions 同步 | 4 个包 + 4 个 guardrails 接线 + 根 `workspaces`/`test`/`typecheck` 链/`verify-layout`/`market-dependency-direction`/beta·stable 的 `tests/package.spec.ts` 清单 |
| 需要自己实现的能力 | 无（L2b 后台任务本轮不做，见 §6） | read 的窗口/流式/超长行、grep 的遍历与结果上限、bash 的前台执行（后台任务两条路线都不提供） |
| 长期维护 | 跟随上游同步（已被 `upstream:sync` 流程覆盖） | 自建代码需逐次适配上游内核变化；且与上游同名工具形成"双实现"漂移风险 |
| 许可 | MIT（三包全部） | 自建代码无许可问题 |

**结论**：B 在 C3 上的优势是数量级。A 只有在 C1/C2 被证伪时才值得付出这个成本。

### C4 安全面 —— 需要显式记账，但不构成否决

**判据**：复挂是否引入新的越权路径？是否改变了既有威胁模型？

- 新面：上游 `write`/`edit` 的沙箱越级参数（`sandbox_permissions`/`justification`）。实测**越不过策略**（spike 报告 §4.5），属可控新增面；实施时写入威胁模型。
- 既有面：`bash` 出网不受 `allow_network` 门控（spike 报告 §3.3 末）——B 与 A 相同（自建 bash 一样要面对），不是路线差异。
- 未复挂的 `tool-web`/`tool-jobs`/`tool-schedule` 等行保持关闭，攻击面不扩大。

**结论**：C4 不改变选型；B 需附 1 条威胁模型条目。

### C5 可回滚性 —— 收尾判据

**判据**：选错了能不能低成本退回？

- B → A：删 3 行配置、关上游行，再上自建包。**因为 B 已经证明工具名与策略契约完全对齐**（C1），自建工具的接口形状已被钉死，退回成本可控。
- A → B：需先下掉自建包与接线，涉及根级清单改动；成本高于 B → A。

**结论**：先做 B 天然保留了 A 的选项，反向则不然。这使 B 成为**信息更优的第一步行**。

## 2. 判定表（对号入座）

| 条件 | 结论 |
|---|---|
| C1 全部满足 + C2 无必须偏离项 | **选 B**（默认；当前实测状态即如此） |
| C1 满足 + C2 有必须偏离项且上游 Config/适配层做不到 | L1/L2 中**该工具**转 A，其余保持 B |
| C1 不满足（若上游改工具名/参数契约） | 该工具转 A，并同步更新 `policy.ts` / `present-as.ts` 契约 |
| L3（web_fetch / screenshot） | **恒为 A**（上游无对应面可复挂） |

## 3. 触发回转（B → A）的条件（任一成立即重开裁定）

1. 上游把 `tool-fs`/`tool-fs-search`/`tool-bash` 从 `dsh-base` 移除、改名，或把它们的行收回 preset 作用域（本变体的 preset 路径已实测不可用）；
2. 实测发现某个上游工具的默认行为不满足已确认产品需求，且 Config 与该变体沙箱组合无法修正（需附实测证据，不能凭推测）；
3. 上游同名工具与自建实现同时存在导致契约漂移（例如上游改掉 `read` 的输出格式而策略文案依赖它）；
4. 变体守卫/`zero-touch` 规则发生变更，导致 host 平面 enable 配置不再可维护（例如上游把"白名单 enable"改成需要 fork 插件）。

## 4. 落地清单（已定稿路线：L1+L2 复挂 / L2b 不做 / L3 自建）

> 行号会随编辑漂移；下面一律用**符号名**定位，落地时以符号为准。

### 4.1 变体层启用（L1+L2）

1. 在 `dsh-plugin-huaanwork` 的变体 compose 层（`src/profile.ts` 的 launcher 补丁序列）给出：
   - `tool-fs`、`tool-fs-search`：`{ disabled: false }`；
   - `tool-bash`（`win32` 为 `tool-pwsh`）：`{ disabled: false, config: { enableRunInBackground: false } }` —— **config 整块替换**（spike §4.2/§4.6），`disabled: false` 与 config 必须落在同一条 patch。
2. 同步守卫与断言：`src/huaanwork-host/row-assertions.ts` 的 `HUAANWORK_ROW_ASSERTIONS`（L1/L2 行从"不在表内"变成显式 enable 断言）、`tests/profile.spec.ts` 的 disable 矩阵、`tests/huaanwork-rowids.spec.ts`（如涉）。
3. **验收**：隔离实例行状态直读（`rows.mjs` 同款）显示 `tool-fs`/`tool-fs-search`/`tool-bash` = `disabled:false` 且 `tool-bash.config.enableRunInBackground === false`；工具面 = 12 个（`read`/`write`/`edit`/`glob`/`grep`/`bash` + 6 git）；`request/header` 中 `bash` 的参数表**不含** `run_in_background`。
4. **Windows 面（本轮无实机证据）**：`tool-pwsh` 的 enable 与 `enableRunInBackground: false` 按同一形态给出，但 macOS 上只能证明平台门控不误开 pwsh；Windows 真机验证并入既有的「Windows 发行面零证据」债项，不阻塞本路线。

### 4.2 保持关闭（L2b）

1. `jobs`/`tool-jobs` 保持 disabled，**不改** `profile.ts` 的这四行 disable 补丁与 `HUAANWORK_ROW_ASSERTIONS` 断言；`job-controller` 的 pending 属既有关闭集合，无需处理。后台任务另立裁定。

### 4.3 自建（L3）

1. 新增 `packages/huaanwork-web-tools`（`web_fetch` + `screenshot`），按 `huaanwork-git-tools` 同形复制 package.json/tsconfig；根 `package.json` 的 `workspaces`/`test`/`typecheck` 链、`scripts/expected-root-gate-scripts.json`、`scripts/verify-layout.mjs`、`scripts/market-dependency-direction.mjs` 检查面、beta/stable 的 `tests/package.spec.ts` 包清单同步。
2. 新增 `src/huaanwork-guardrails/web.ts` 接线，并同步 `src/profile.ts` 的 insert 列表（保持既有插入顺序契约）、`package.json` 的 exports map、`tsdown.config.ts` 的 entry。
3. `packages/huaanwork-policy/src/decide.ts` 新增 `web_fetch`/`screenshot` 两条 ALLOW case（**仅这两条**；`list_dir`/`task_output`/`task_kill` 已随复挂撤回）。
4. `web_fetch` 门控实现：复用 `isLanEndpoint`，`allow_network=true` 放行；`false` 时公网拒绝（结构化错误指路 设置→权限）、局域网放行。
5. `screenshot`：先确认 attachment 面（`ImageBlock` 需要 `ImageAttachmentRef`，不可达则只返回 PNG 路径）；playwright-core 进入 `dsh-plugin-huaanwork` 依赖面并通过 `verify:licenses`/`runtime-closure`/打包清单。
6. **验收**：`huaanwork-web-tools` 单测覆盖门控三类目标（公网拒 / 局域网放行 / `allow_network=true` 全放行）+ `decide.test.ts` 两条判定钉 + `web` 接线的 cordis 测试（同 `git.cordis.spec.ts` 模式）。

### 4.4 威胁模型与回归

1. 补三条威胁模型条目：`bash` 出网旁路（不受 `allow_network` 门控）、`write`/`edit` 的沙箱越级参数（已证越不过策略）、`nohup`/`&` 自管后台进程（L2b 不做时的既有旁路）。
2. 回归基线：`corepack yarn check`（完整门禁）+ spike 报告的四组隔离实验（A/B/C/D）与 `rows.mjs` 行状态直读；提交前另跑 `corepack yarn check:desktop-variants`。

## 5. 证据索引

- 设计文档：`2026-10-12-agent-toolbox-design.md`（裁定 5 = 三层结论；裁定 3 = 局域网放行；L1/L2 收口裁定）
- spike 报告：`2026-10-12-agent-toolbox-spike-report.md`（§3 运行时证据 / §4.1-4.4 preset 不可用 / §4.5 提权实测 / §4.6 后台任务硬锁定 / §4.8 依赖面）
- 上游包行为：`deepseek-harness/packages/fs/tool-fs/src/index.ts`（read 旋钮）、`sandbox.ts`（提权 API）、`tool-fs-search`（ripgrep 走子进程）
- 本变体契约：`packages/huaanwork-policy/src/decide.ts:78-96`、`dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:6-26`

## 6. L2b（后台任务）单列：为何本轮不做

| 事实 | 出处 |
|---|---|
| `jobs`/`tool-jobs` 的 disable 由 launcher 补丁在机器级 patch **之后**重放，且被 `HUAANWORK_ROW_ASSERTIONS` 断言 ⇒ **不可配置** | `profile.ts:1448-1449`、`row-assertions.ts:19-20`；spike §4.6 行状态直读 |
| 只翻 `tool-bash` 会让 `run_in_background` **可见但必败** | 实测错误 `background jobs unavailable: …`（`tool-bash/src/index.ts:503-506`），参数仍被广告（`:394`） |
| 干净回退：`enableRunInBackground: false` 从 schema 移除参数，调用期仍强制拒绝 | `tool-bash/src/index.ts:502-505` |
| 既有旁路：full 档下模型可用 `nohup … &` 自管后台进程 | spike §4.6 |

**判定**：解锁 L2b = 改 M3 锁定层 + 行断言 + `profile.spec.ts` 矩阵 + 自己的威胁模型论证（`job_*` 需进 `present-as` 白名单、无人值守清单复核），超出本轮"补齐工具面"的范围。本轮取"契约诚实"的低成本形态，后台任务作为独立裁定项登记。
