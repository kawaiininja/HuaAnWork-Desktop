# 《中立会话独立子根与自动化任务自动绑定项目》规格评审意见

- **评审对象**：`docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design.md`
- **评审日期**：2026-11-07
- **评审方式**：对照华安宿主当前源码复核。本文件只记录评审意见，不修改设计稿，也不修改实现
- **评审结论**：**ITERATE（有条件通过）**。按可写根拆开中立会话和未绑定自动化、不改 `TurnScheduler` 的互斥原语，方向与现有调度器一致，可以留在规格里。§3.1 把这些新根放进 `<profileDir>/workspace`，而 `work-1` 与存量中立会话的沙箱根仍是这棵树本身。调度器会把父子路径当成两把锁，并行之后它们会同时写同一批文件。今天至少还会因为同一把锁排队。批准进入实施计划之前，须先把下面的 P1 写进规格

## 一、复核后可以留下的部分

| 规格决定 | 处置 | 复核要点 |
| --- | --- | --- |
| 不改 `TurnScheduler` 的按根互斥 | **维持** | `rootWriters` 的键是 `resolve` 后的路径（`turn-scheduler.ts:97`、`:120`）。路径不同就可以在 `max_concurrent_turns` 内并行。同一次会话、同一个项目根继续串行，这句也成立 |
| `work-1` 与升级前 cwd 恰好是中立根的存量会话留在 `<profileDir>/workspace` | **维持** | 客户端对默认标签传 `fresh: chatId !== "work-1"`（`App.tsx:2680-2682`）。`fresh: false` 时 `sessionNew` 用 `sessionIdFor(cwd)`（`sessions.ts:1038-1041`）。这条稳定会话继续占中立根，和规格 §2 的表格一致 |
| 新建独立中立会话在 `session.new` 里分配自己的根 | **维持方向**，根的位置按 P1-1 改 | 未绑定标签的 cwd 来自 `sessionCwdForTab`，没有项目时就是中立根（`App.tsx:1362-1365`、`:2678-2682`）。在 `fresh === true` 且基准 cwd 等于中立根时换根，打中的是这条路径 |
| 存量 `projectId: null` 的自动化不再占用中立根 | **维持方向**，目录位置按 P1-1 改 | `automationAdmissionRoot` 今天在没有有效项目时返回 `neutralWorkspaceRoot`（`automations-host.ts:195-200`）。改成每条自动化一个目录，调度器不用新原语 |
| 已删除项目仍记 `MISSING_PROJECT_OUTPUT` 并在执行前返回 | **维持**，时序按 P2-3 钉死 | `executeRun` 在 `runAgentTurn` / `runScript` 之前就返回（`automations-host.ts:578-598`）。未交接时 `finally` 会 `admission.release()`（`:654-661`） |
| 为 `projects.json` 补读写锁 | **维持** | `createProject` 是整文件读改写，没有锁（`stores.ts:65-80`）。自动创建会和用户手动创建项目交错。锁本身成立；它包不住「建项目 + 建自动化」的原子性，见 P2-4 |

## 二、必须先写进规格的修正

### P1-1 新根不能放在仍有写者的 `<profileDir>/workspace` 里面（§2、§3.1、§3.2.4）

§3.1 把三类新目录都放在中立根之下：

- `<profileDir>/workspace/sessions/<sessionId>`
- `<profileDir>/workspace/projects/<projectId>`
- `<profileDir>/workspace/automations/<automationId>`

`work-1` 和存量中立会话的可写根仍是 `<profileDir>/workspace`（§2 表格、§3.2.3 的 3a）。沙箱在传了允许根时，请求路径落在该根之内就原样使用（`sandbox-cwd.ts:71-78` 的 `pinnedCwd`）。子目录属于父根，默认会话可以改每一个新会话目录、每一个自动项目和每一条存量自动化的兜底目录。子目录上的会话写不回父目录，也写不了兄弟目录。洞是单向的。

`TurnScheduler` 只比较路径字符串是否相同。父路径和子路径是两把锁，§3.1 列出的五类任务会在 `max_concurrent_turns` 内同时运行。§3.1 的「隔离性质验证」只证明了锁的键不同，没有证明文件互不可写。

这也会逼出 §3.2.4 对清扫的特判。今天 `protectedRoots` 传入 `[neutralWorkspaceRoot]`（`index.ts:195-201`），`cwdWithinAnyRoot` 命中就整段跳过（`session-sweep.ts:152-153`）。注释写明原因：已登记项目根可能是中立根的祖先目录，前缀比较会误删中立会话（`session-sweep.ts:84-86`）。自动项目若落在 `workspace/projects/` 里，整棵 workspace 受保护就会让这些项目下的无引用会话扫不掉。规格因此把保护收成「恰好等于 workspace，或位于 `sessions/`、`automations/`」。收窄之后，workspace 下其余目录在祖先项目存在时会重新变成可清扫对象。

规格要改成：

- 新建中立会话的根、存量未绑定自动化的根、自动创建项目的 `root`，都与 `<profileDir>/workspace` 平级，不作为它的子目录。默认会话的沙箱碰不到它们。
- `<profileDir>/workspace` 继续只给 `work-1` 和升级前 cwd 恰好是该目录的存量会话。现有「cwd 落在 workspace 内就永不清扫」的规则不收窄。
- 会话子根和存量自动化目录本身列入 `protectedRoots`。它们即使落在某个祖先项目的前缀里，也不参加项目存量清扫。自动项目是普通项目根，沿用现有清扫，不为它们新写一套谓词。
- 侧栏若仍展示自动项目，展示的是 `projects.json` 里的条目。条目的 `root` 同样不能落在任何一个仍有写者的目录里面。

### P1-2 可写根推导只为已经铸好的独立中立会话返回子根，并且推导阶段不建目录（§3.2.1、§3.2.3）

§3.2.3 第 5 步对匹配不上的会话一律返回 `neutralSessionRoot(profileDir, sessionId)`。§3.2.1 的 `neutralSessionRoot` 会 `mkdirSync`。`writableRootForSession` 在发送和恢复时都会被调用（`sessions.ts:404`、`:947`）。未知会话 id、已删除项目的旧会话，都会在拒绝恢复之前留下一个空目录。

已删除项目的会话今天会落到中立根，再因持久化 cwd 不在该根内被拒绝（`sessions.ts:415-418`）。改成第 5 步之后仍然拒绝，但每次恢复都先建目录。2026-11-06 的并发评审已经要求把推导阶段的 `mkdirSync` 移走：目录只在这次发送确实使用该根时创建。

§3.2.1 还写：`sessionId` 或 `automationId` 含路径分隔符或 `..` 时回退到 `neutralWorkspaceRoot`。回退后这条会话和 `work-1` 共用父根的写者名额与沙箱。非法 id 应直接拒绝。

§3.2.2 把 `freshSessionIdFor(neutralRoot)` 写成 `huaanwork-session-<12hex>-<8hex>`。实际格式是 `huaanwork-` 加根路径 SHA-256 的前 16 位十六进制，再加 `-` 和 8 位随机串（`session-id.ts:5-11`）。按规格里的形状做校验，合法 id 会被判成非法，再按上一条回退到父根。新会话又和 `work-1` 挤在一起。

规格要改成：

- 只有 `fresh: true` 且基准 cwd 等于中立根、已经由 `sessionNew` 铸出的会话，推导结果才是它自己的子根。会话 id 仍用 `freshSessionIdFor(中立根)`，以便用「中立根稳定 id 加 `-`」认出来。
- 推导函数只返回路径，不创建目录。目录在 `sessionNew` 确定要把该路径交给这条新会话时创建。
- 任务绑定、项目稳定前缀、唯一项目 cwd、通道默认稳定会话、以及其余未认出会话，维持 2026-11-03 规格 §5.1.1 的现有回落，最终回到中立根，不发明新目录。
- 路径分量校验失败时拒绝这次铸造或删除，不把该会话收进中立根。

### P1-3 存量兼容不能只认 cwd 与中立根完全相等（§3.2.3、§4 场景 1）

§3.2.3 的 3b 只在 `resolve(headerCwd) === neutralRoot` 时把带中立前缀的旧会话留在父根。cwd 在 workspace 之内但不是根本身的旧会话，会被指到新的空子根。随后 `ensureChannelAgent` 的 `isInside(root, persisted.cwd)` 失败（`sessions.ts:415-418`），恢复被拒。

规格要补上：会话 id 带中立根稳定前缀，且持久化 cwd 等于中立根或位于中立根之内、又不属于 P1-1 那些独立根的命名空间时，可写根仍是 `<profileDir>/workspace`。已经落在独立子根上的新会话继续用该子根。

## 三、应一并写清的缺口

### P2-1 `projectId: null` 从「中立」变成「自动建项目」是 RPC 合同变化（§2、§3.3.2、§3.3.5）

今天 `automation.create` 只在 `projectId !== null` 时检查项目存在，`null` 直接放行（`routes.ts:1135-1147`）。输入框里的调度短语也以 `projectId: null` 进入创建表单（`App.tsx:2572-2578`）。规格把这个值改成「先建同名项目再绑定」。

这可以做，但要写成破坏性变更：既有调用方、测试和「不绑定」文案都会开始产生 `projects.json` 条目。创建表单的默认项文案单独改不够。

### P2-2 放开 `projectId` 改绑时要写清在途回合和旧文件（§3.3.3）

`AutomationInput` 写明创建后不可改，update 白名单不含 `projectId`（`automations-store.ts:74`）。放开之后规格没有写这三句：

- 已经准入的那一轮继续用准入时的根。下一轮才用新项目。
- 旧目录里的文件不搬家。
- 该自动化有在途运行时拒绝改绑。

只允许改成非空且存在的项目 id，这一句规格已经有，保留。

### P2-3 已删除项目的兜底根不能先跑完再记失败（§3.3.4）

§3.3.4 的代码在项目找不到时返回 `neutralAutomationRoot`，正文又说 `executeRun` 仍记 `MISSING_PROJECT_OUTPUT`。两句都成立的读法只有一种：准入可以占住该自动化自己的兜底根，执行体在 `runAgentTurn` / `runScript` 之前按现有分支记失败并返回，释放走现有的未交接 `admission.release()`。

规格要写明这个顺序。不能在兜底目录里把提示词或脚本执行完，再补一条项目不存在的失败记录。`projectId === null` 的存量任务没有「项目已删除」，应在兜底根上真正执行。两种情况不要合成一个分支。

### P2-4 自动建项目的失败回滚不是事务，留下的项目要有口径（§3.3.2、§4 场景 3、场景 6）

`createAutomation` 已经在自动化注册表锁内检查 `MAX_AUTOMATIONS`（`automations-store.ts:283-288`）。先检查上限再建项目，可以少留孤儿，这一句成立。`createProject` 成功之后进程退出，或写自动化表失败后的回滚本身失败，侧栏仍会留下空项目。规格里的「事务原子性」做不到，改成尽最大努力回滚，并写明崩溃窗口会留下空项目。

删除自动化保留项目，是规格已确认的产品选择。同时要写明后果：侧栏按创建时的任务名积累项目；同名任务得到同名项目，只靠 UUID 目录区分；之后重命名自动化不会改项目名。`removeProject` 今天只删注册表条目（`stores.ts:94-101`），不删磁盘目录。自动项目被用户从侧栏删除后，目录是否保留要写一句，避免和「用户目录一律不删」混成默契。

### P2-5 测试要锁住沙箱隔离，不能只锁 `started: true`（§6）

§6 的并发用例只要求两个中立会话都返回 `started: true`。P1-1 的失败形态恰好是两者都成功启动，然后父根上的回合写进子目录。

规格的测试计划要补上：

- 默认会话的允许根是 `<profileDir>/workspace` 时，向独立会话根和自动项目根的写入被夹回默认根，文件不出现在那些目录里。
- 两个独立中立会话的允许根互不包含，任一方的越界路径收回到它自己的根。
- 推导一个未知会话 id 不创建 `sessions/` 下的新目录。
- 祖先目录被登记为项目时，独立中立会话和存量自动化目录的日志仍不被项目存量清扫删除；自动项目下无任务引用的游离会话仍会被清扫。

## 四、不在本轮改的范围

以下句子复核后不需要因本次评审改写：不改 `TurnScheduler` 的单写者原语；同一会话的下一条消息继续排队；绑定到同一真实项目的自动化和该项目子任务继续共享 `project.root`；会调用模型的自动化仍占 `max_concurrent_turns`；脚本槽位上限仍是 2；`work-1` 不迁移到新目录。
