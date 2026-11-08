# 《中立会话独立子根与自动化任务自动绑定项目》实现评审意见（Code Review）

- **评审对象**：`feat/huaanwork-neutral-subroots-and-automation-projects` 分支相对 `master`（`e3d62edf68`）的完整实现
  - 分支已提交区间仅 `586a8e8428`（docs：计划定稿，无产品代码）；**实现全部位于工作区（未提交）**，共 13 个生产文件 + 12 个测试文件 + 2 份计划文档的 EOF 空白修正
  - 本轮审查范围：`git diff 586a8e8428`（基线提交 → 当前工作区），含实施期终审修复轮之后的最终树
- **对照基准**：
  - 设计规格：[`docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design.md`](../specs/2026-11-07-neutral-subroots-and-automation-projects-design.md)（§2 裁定、§3.1 拓扑/沙箱、§3.2 Part A、§3.3 Part B、§4 边界、§6 测试计划）
  - 实施计划：[`docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md`](./2026-11-07-neutral-subroots-and-automation-projects.md)（Global Constraints、File Structure 表 = 恰好 13 个生产文件、Tasks 1–8、Decision ledger R1–R7、NOT in scope）
  - 实施就绪评审：[`2026-11-07-neutral-subroots-and-automation-projects-implementation-review.md`](./2026-11-07-neutral-subroots-and-automation-projects-implementation-review.md)
- **评审日期**：2026-11-08
- **评审方式**：只读核对工作区源码、测试与文档；未改任何产品代码/测试/文档（本文件为唯一新增产物）。门禁数据沿用实施期最终验证，本轮按只读要求未重跑。diff 工件仅置于 `/tmp`，不入库。
- **最新总结论（2026-11-08 质量审查轮，见 §A）**：**代码质量 Approved with minors；0 Critical / 0 Important / 5 Minor。** 代码层面达到合并标准（GO），前提是计划强制的 **T7 真机走查**（Task 8 Step 6）与**提交后门禁重跑**——这两项不是代码缺陷。推导顺序、回滚所有权规则、锁序（P→A，无 ABBA）、错误透传、四条删除钉子字节未改、13 生产文件边界均经核验成立；已接受残余（D5 删除窗口、改绑 check-then-act、E5 累积）在代码中如实记录。

---

## A. 2026-11-08 质量审查轮（只读，对照规格与计划）

### A.1 成立项（ strengths ）

| 维度 | 核对结论 | 证据 |
| --- | --- | --- |
| 推导顺序 = 规格 §3.2.3 步骤 1–6 | 任务绑定 → 项目稳定 id（含 D3 例外）→ 中立分支（存量 workspace cwd → 已铸造 cwd → 目录已存在 → D4 兜底）→ 仅非中立的唯一项目 → 仅非中立的自动化根 → 中立兜底 | [writable-root.ts:30-92](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L30-L92) |
| P1-2 无副作用 + 非法分量抛错 | 非法分量在任何 `join` 前经 `assertSafePathSegment` 抛错；推导与准入均不 `mkdirSync` | [writable-root.ts:49-51](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L49-L51)、[automations-host.ts:197](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L197) |
| D3 / D4 | D3 例外排除精确 work-1 id（要求 `-` 前缀）；D4 终止返回 workspace，不按 cwd 改判 | [writable-root.ts:82](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L82) |
| 回滚数据安全 | 仅非递归 `rmdir`；非空/不可读/被引用时登记与目录一并保留；摘登记失败恢复空根；重抛原始错误 | [routes.ts:519-556](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L519-L556) |
| 错误透传（C1 修复成立） | `session.new` 已包 `sessionRoute`；`errorRoute` 把任意 `Error` 映射为 400 + 原文，mkdir 失败原样到达客户端 | [routes.ts:584](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L584)、[routes.ts:169-179](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L169-L179) |
| 锁序无 ABBA | `automation.create` 与 `project.remove` 均 P→A；回滚只在自动化锁释放后取项目锁 | [routes.ts:1140-1146](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1140-L1146) |
| 改绑 check-then-act 诚实 | 注释明示窗口不消除；已准入轮次冻结旧根 | [routes.ts:1247-1249](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1247-L1249) |
| D5 诚实口径（I3 修复成立） | 注释如实写明摘掉根登记后 `pinnedCwd`/`sessionWorkspaceRoot` 回落前台根；与代码一致 | [sessions.ts:612](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L612)、[sandbox-cwd.ts:71-86](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts#L71-L86) |
| 孤儿无日志说明（I4 修复成立） | 就地注释，未放宽删除条件 | [sessions.ts:627-629](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L627-L629) |
| 四条删除钉子字节未改 | diff 中四个测试体零 `-` 行 | [sessions.spec.ts:1562](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts#L1562)、[:2346](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts#L2346)、[:2669](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts#L2669)、[:2975](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts#L2975) |
| D4 既有钉子未改 | 仅头注释与导入行变动，测试体不变 | [writable-root.spec.ts:140](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts#L140) |
| B4 / 边界 | `automations-host.ts` 零 `neutralWorkspaceRoot` 命中；`turn-scheduler.ts` 与 `deepseek-harness/` 零 diff；恰好 13 生产 + 12 测试 + 2 docs EOF | 见 §C |

回滚故障注入夹具经核对真实存储形状成立：`writeProjectRegistry` 直写（[stores.ts:40](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/stores.ts#L40)）、`readAutomationRegistry` 非 ENOENT 重抛、tmp+rename 写盘；四模式（nonempty / referenced / remove-fails / read-fails）驱动真实路由 + 真实文件系统，断言磁盘终态、注册表内容、日志与原始错误保留，非 mock 缝。

### A.2 五条 Minor（不挡合并；本轮均未改动）

#### Minor-1｜回滚 `removeProject` catch 误报并发删除情形（新发现，不在 ledger）

- **位置**：[routes.ts:547-555](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L547-L555)
- **证据与触发**：`rmdir(projectRoot)` 成功后、`removeProject` 之前，若用户并发删掉了该自动项目，store 抛 `project … was not found`；catch 仍 `mkdir` 重建空目录并记「项目登记删除失败，保留项目」，而实际上注册表已无该条目。
- **为何重要**：结果是无害的未登记孤儿目录（E5 类）+ 一行误导日志，**无数据丢失**。属计划裁定的 catch 形状。
- **修法（日后若动此处）**：对 not-found 特判——既无需恢复目录、也无条目可保留，直接返回；其余错误才走恢复空根 + 日志。

#### Minor-2｜C1 路由测试的 Windows 失败正则（建议从 parked 提升为应修）

- **位置**：[routes.spec.ts:1567](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts#L1567)（测试体 [:1545](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts#L1545)）
- **证据**：断言 `expect(error.message).toMatch(/ENOTDIR|not a directory/i)`。Windows 上父路径为文件时 Node 报 `ENOENT`，该正则不匹配。
- **为何重要**：现有 CI 的 Windows job 只跑 `check:win-package:platform`，不受影响；但任何本地 Windows 全量测试会红。这是 ledger 已 parked 的 Task 8 残余，一行即可消除。
- **修法**：放宽为 `/ENOTDIR|ENOENT|not a directory/i`（仍钉「真实文件系统错误原文到达客户端」，不弱化语义）。

#### Minor-3｜`concurrentTurn.spec.ts` 注释夸大非 Error 行为

- **位置**：[concurrentTurn.spec.ts:114](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts#L114)、[concurrentTurn.ts:116-122](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts#L116-L122)
- **证据**：注释称非 Error 值「不得变成空串或 [object Object]」，但纯对象 error 实际返回 `"[object Object]"`；测试只钉了字符串非 Error。
- **为何重要**：函数形状是计划裁定（D6=F），且 `rpcCall` 实践中抛 `Error`，属注释/测试诚实度打磨，非行为缺陷。
- **修法**：把注释收窄为「字符串非 Error 原样可见」，或补一条纯对象用例并如实断言 `[object Object]`。

#### Minor-4｜`writable-root.ts` 头注释「读一次」与双 stat / TOCTOU

- **位置**：[writable-root.ts:16](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L16)、[:55](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L55)、[:78](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L78)
- **证据**：头注释称「existsSync + statSync 一次」，但 fresh-minted 路径在 `mintedDirectoryReady`（:55）与步骤 3（:78）各读一次；`existsSync → statSync` 在并发 `session.remove` 删目录中途可抛裸 ENOENT。
- **为何重要**：诚实失败（非静默），但注释与读次数不符。计划裁定形状，保持延后。
- **修法**：注释改为「至多两次」；如需无竞态单读，用 `statSync(mintedRoot, { throwIfNoEntry: false })?.isDirectory()`。

#### Minor-5｜`routes.ts` 注释行号漂移 + 上限文案重复

- **位置**：[routes.ts:1206](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1206)、[automations-store.ts:289-290](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts#L289-L290)
- **证据**：注释引 `automations-store.ts:286-288` 指锁内上限复检，实际在 `:289-290`；上限文案字面量在路由与 store 各一份（当前一致）。
- **为何重要**：文档准确性；仓库约定现偏好「符号 + 行号」双引。
- **修法**：行号订正为 `:289-290`（或改引符号 `createAutomation` 锁内复检）；文案可抽常量，亦可接受现状。

### A.3 延后项 / 裁定复核（triage）

- **建议提升为应修（廉价）**：Minor-2（Windows 正则）——已知未来测试失败，一行修复，park 无收益。
- **维持延后（认可 ledger）**：
  - Task 1：trim-return 契约（所有调用方均消费返回值，已核）；Windows 保留名/尾点空格（不可达：动态 id 均为生成的 hex/UUID，且 `session.remove` 的 rm 另需中立稳定前缀）；base-dir/纯度缺直接单测（纯度已由推导层 `existsSync === false` 钉住）；沙箱测试注释夸大（注释 nit）。
  - Task 2：双 stat 注释 + TOCTOU（Minor-4，计划裁定）；D3 `resolve()` 字符串相等可被符号链接/大小写变体的 workspace-项目根绕过——**维持**：词法比较是计划明示 NOT-in-scope，后果限于罕见的「workspace 被登记成项目」配置。**D4-under-automations 缺测已在修复轮解决，应从清单划掉。**
  - Task 3：chmod rm 失败钉子的 root 敏感性（仅当出现 root CI 才加 `getuid()===0` skip）；项目标签句子在 `concurrentTurn.ts` 与 `App.tsx` 守卫各一份字面量（行为测试钉两者相等，计划刻意选字面量）；级联删除不清兄弟根（明示 NOT-in-scope，已记录）。
  - Task 4：并发测试 RED 依赖真实 fs 交错（GREEN 确定，可接受）；`createProject` 跨 `stat()` 持锁（慢/网络根 stat 会串行化注册表写——性能 nit）；`project.create` HTTP 面不暴露 `id`（仅 Task 6 消费，无需 API 变更）。P→A 锁序在 create 与 project.remove 均已核。
  - Task 5：改名后的调度器测试标题声称「not the neutral root」却只断言 `tick-ok`（根主张确由 `automations-host.spec.ts` 的 realpath 断言钉住，标题略夸大）；`admissionRoot` helper 委托生产 `automationAdmissionRoot`（brief 裁定，断言查真实 fs 结果，属缝复用而非 mock 被测缝）。**探针 release 键 / EEXIST-only 已修复，应划掉。**
  - Task 6：上限预检测试接受残留空 `workspace-projects` 父目录（弱于 `existsSync === false`，但预检路径不 mkdir）；T3 裸 `rejects.toThrow()`（EISDIR 形状已在 remove-fails 模式钉住）；`vi.waitFor` 1s 预算（本地跑 3 次，慢 CI 可能 flake）；`failAutoProjectCreate` 的 chmod 恢复在 `finally` 外（当前安全：`creating` 不 reject 且恢复先于 setupError 重抛）；keep 分支日志断言未钉原因子串（两条日志文案不同，`toContain('不可读')`/`toContain('非空')` 会更强）。均维持。
  - Task 7：projects 加载期空列表渲染「原归属项目已删除」占位——**维持，计划裁定 JSX**；保存仍安全（未改绑定时省略 `projectId`）。全局 `automation.update` stub 与 `onChanged`→运行删除时多一次 `project.list`（无害测试卫生/RPC nit）。**省略分支测试 / App 过期注释已修复，应划掉。**
- **裁定复核**：
  - R-PRE-1 / R-FIN-2（不提交；提交后重跑 `check:whitespace`）：鉴于计划 Global Constraints 正确。**须向用户 surfaced 的后果**：实现目前仅存在于工作区，分支门禁在提交前看不到它。
  - R-PRE-2/3/4、R-PRE-6、R-FIN-1：认可，无变更。**R-PRE-4 要紧**：T7 真机走查是计划完成标准，已如实记为未跑，不得声称通过。
  - **D5=E 理由订正（标注：计划裁定，已接受）**：原理由「爆炸半径限于该会话自己的兄弟根」事实不完整——摘掉根登记后，残留回合回落前台根，剩余写可能落进共享 `workspace` 或当前项目根。实现注释（I3 修复）现已如实写明，符合裁定要求的诚实口径。真正的机制补救（从 `header.cwd` 推导 `workspace-sessions` 下的允许根）正确地留在 13 文件范围外，作为 parked 首选；若日后重访此残余，它是第一候选。不将裁定本身判为错——它是用户的绑定裁定，残余现已诚实记录。
  - `automation.update` check-then-act 裁定：实现与文档正确（[routes.ts:1247-1249](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1247-L1249)）；T6 用真实 marker 文件与 `realpath` cwd 输出证明「冻结旧根/下一轮新根」。无变更。

### A.4 规格 / 计划对齐

- **计划功能全部就位**：Part A 铸造/删除/清扫保护，Part B 自动建项目/绑定/改绑守卫/存量准入，UI 默认项 + 编辑 + 刷新，D6 纯函数 + 两层测试。File Structure 表精确匹配（13 生产文件）；Tasks 1–8 产物均可定位。无多余生产面；docs 改动仅两处 EOF 空行。
- **规格 §3.3.2 vs 计划 B3（规格同步提示）**：规格回滚示意仍写 `rm(projectRoot, { recursive: true, force: true })`，已被计划第二轮修订（非递归 `rmdir` + keep/补偿）取代；实现跟随计划（绑定权威）。这是已记录的规格精化，**非实现偏差**——建议日后给规格补一行同步。
- **规格 §6.4** 点名 `AutomationsView.spec.ts`；UI 测试按计划 Task 7 落在既有 `automations-runs-delete.spec.ts` 挂载夹具——计划一致。
- **待办（如实记录）**：T7 真机走查（7 场景，Task 8 Step 6）未跑；提交后 `check:whitespace` 重跑（R-FIN-2）。

---

## B. 实施期终审与修复闭环（审计轨迹）

实施期曾做一轮全分支终审（范围 `586a8e8428 → b6995402ef` 工作区快照），结论 **With fixes**；随后一轮修复 + 定向复审，全部 ADDRESSED。本轮（§A）是在该修复之后的最终树上做的独立质量复核，确认修复仍成立。

| 编号 | 终审发现 | 处置 | 复审 |
| --- | --- | --- | --- |
| C1（Critical） | `session.new` 是唯一未包 `sessionRoute` 的会话路由，新增 mkdir 失败以 `Internal Server Error` 到达用户，违背 D2/D6「显示真实错误」 | 包上 `sessionRoute`（[routes.ts:584](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L584)）+ 订正「纯内存/无 I/O」注释 + 路由级测试（文件堵住 `workspace-sessions` 制造真实 ENOTDIR，变异验证去掉包装即红） | ADDRESSED |
| I2（Important） | 分支 `check:whitespace` 红：两份基线计划文档 EOF 空行；实现未提交故门禁看不到 | 删两份文档 EOF 空行（仅空白）；**不提交**（计划禁止） | ADDRESSED |
| I3（Important） | D5 注释夸大爆炸半径：摘根登记后残留回合回落前台根 | 按事实改写注释，不改行为（[sessions.ts:612](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L612)） | ADDRESSED |
| I4（Important） | 已铸造但从未写日志的兄弟根无回收路径 | 就地注释说明，不放宽 D5 删除条件（[sessions.ts:627-629](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L627-L629)） | ADDRESSED |
| M1 | 改绑省略分支无测试 | 补「未改绑定 ⇒ update body 无 projectId」用例 | ADDRESSED |
| M2 | 中立前缀 cwd 在 `workspace-automations` 下应留 workspace 无测试 | 补 D4 负例 | ADDRESSED |
| M3 | `fresh + 项目 cwd` 不建子根无测试 | 补用例 | ADDRESSED |
| M4 | 探针 release 键错（`work-1-probe` vs `work-1`）；EEXIST-only | 改 `release('work-1')`；放宽 `/EEXIST|ENOTDIR/` | ADDRESSED |
| M5 | `App.tsx` 创建表单归属默认项过期注释 | 订正为「默认自动建同名项目」 | ADDRESSED |

定向复审另记两条低severity注记（不阻断）：C1 测试正则在 Windows 可能因 ENOENT 失败（即本轮 Minor-2）；M4 新增注释「后面的用例」措辞不精确（harness 逐测试新建，影响的是本测试后续步骤）。

---

## C. 门禁证据（实施期最终验证；本轮只读未重跑）

| 门禁 | 结果 |
| --- | --- |
| `corepack yarn typecheck` | exit 0 |
| 计划 Task 8 的 13 个定向 spec | **423/423 passed**（13 files） |
| `corepack yarn test`（根） | **exit 0**；plugin 包 **3825 passed / 14 skipped (3839)**，其余 workspace 全绿 |
| `git diff --check` | exit 0 |
| 边界 | 恰好 13 生产 + 12 测试 + 2 docs（EOF 空白）；`deepseek-harness/` 与 `turn-scheduler.ts` 零 diff |
| `corepack yarn check:whitespace` | 仍红，**唯一原因**是脚本只检查已提交 `merge-base..HEAD`，实现尚未提交；两份基线文档 EOF 空行已在工作树修掉，提交后即可见 |

---

## D. 待人工 / 提交后事项与 parked

- **T7 真机走查未跑**（计划 Task 8 Step 6 的 7 项：双标签并行、各自 workspaces、铸造失败真实错误 + 草稿留存、删除在途会话日志、自动项目侧栏即时出现、运行中禁改绑/非运行改绑、未验证平台记录）。**完成标准，不得声称通过。**
- **Windows 未验证**；**完整 `corepack yarn check` 未跑**（含 build/`verify:aa`；计划 Task 8 只要求 typecheck + 定向 vitest + `yarn test`）。
- **提交后**：重跑 `corepack yarn check:whitespace`（R-FIN-2）；实现目前仅在工作区。
- **Parked（需另立裁定，非本轮范围）**：
  1. 为已删但仍在执行的会话从 `header.cwd` 推导沙箱允许根（改 `sandbox-cwd.ts`，超出 13 文件范围）——D5 残余的真正机制补救，重访时第一候选。
  2. `session.remove` 在日志缺失时也删兄弟根（放宽 D5 已接受的删除条件）——需对「铸造但无日志」的所有权另作裁定。
- **本轮建议同批低风险修复（待用户授权，本轮未改）**：Minor-2（Windows 正则一行）、Minor-1（not-found 特判）。其余 Minor 为注释/文档打磨，可延后。

---

## 结论

**代码质量：Approved with minors（0 Critical / 0 Important / 5 Minor）。代码层面 Ready to merge：Yes**，条件为计划强制的 T7 真机走查与提交后门禁重跑（均非代码缺陷）。本轮严格遵守只读要求，未改动任何代码、测试或既有文档；本文件为唯一新增产物。
