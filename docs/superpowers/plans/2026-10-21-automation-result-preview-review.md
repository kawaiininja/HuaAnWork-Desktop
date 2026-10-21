# 《自动化结果预览、运行记录删除与停止》实施计划评审

- **评审对象**：`docs/superpowers/plans/2026-10-21-automation-result-preview.md`
- **对照规格**：`docs/superpowers/specs/2026-10-21-automation-result-preview-design.md`（2026-10-21 终审通过）
- **评审日期**：2026-10-21
- **评审方式**：对照规格与当前源码核对计划中的命令、锁、在途表和下载落点。未把本计划当作对外上手文档去做浏览器走查。
- **评审结论**：**有条件通过**。折叠、锁内重读、`runId` 前移、停止侧单次消费、清理保留 20 条，与规格一致，可以照着做。写代码前要先改下面 1–4。第 5 条只是引用错误，结论本身成立。

## 已核对、可以保留的部分

| 计划落点 | 核对结果 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run` | 与 `dsh-plugin-huaanwork/package.json` 的 `test` / `vitest` 一致 |
| `foldRunAssistantItems` 把附件插在第一条助手气泡的位置 | 第一条助手气泡之前全是非助手项，用原下标切过滤后的数组，位置是对的 |
| 注册表锁内用 `recentRuns` 重读，不套运行记录锁 | `recentRuns`（`stores.ts`）是裸读。`rewriteLastRunFromRuns` 在锁内重读、跳过 `missed`、看见 `running` 则不回写，符合规格 §6 |
| `runId` 在 `dispatchEnqueue` 生成，`runBound` 不再生成 | 符合规格 §8。调用方已传入的 `runId` 会保留 |
| 停止在任何 `await` 之前把 `slotConsumed` 写成 true，执行体不再消费第二遍 | 符合规格 §8 的单次所有权 |
| `AUTOMATION_SESSION_RETAIN_LIMIT = 20` 与 `RUNS_LIMIT` 分开 | 符合规格 §7 |
| 删除前 `releaseSession`，运行记录详情按 `sessionId` 关闭 | Task 9 / Task 10 符合规格 §6 |
| 变体守卫不必新增白名单条目 | 结论对。理由见第 5 条 |

## 写代码前要改的

### 1. N2-O1 没有被 `await` 关掉

计划开口项表写 Task 8 闭窗：`stopAutomation` 返回前 `await Promise.all(consumptions)`。规格评审 §7.3 也建议用这次等待关掉窗口。

调度器的 `listAutomations` 读注册表时不拿 `withAutomationRegistryLock`。`consumeSkippedSlot` 的磁盘写入让出事件循环之后，下一拍仍可能读到旧的 `nextRunAt` 并再次入队。等待只让停止接口晚一点返回，不挡住这次读取。

处置：开口项改回「接受这个窄窗口」。不要写成已经修好。若以后真要关掉，调度入队前先看在途表里已经声明消费的任务，而不是只在 `stopAutomation` 里等待。

### 2. 一次性任务的排队跳过可能写回 `nextRunAt`

规格 §8：日程种类是 `once` 时，停用任务并去掉 `nextRunAt`，不再推进别的档。

计划里 `consumeSkippedSlot` 的 `once` 分支在 `nextFireAfter` 仍有返回值时把它写回 `nextRunAt`。到期的一次性任务通常得到空档，这条分支出不来。未到期却被跳过时，会留下一个未来时间。

处置：`once` 分支只做 `enabled = false` 和 `delete automation.nextRunAt`。

### 3. 同步段注释停在 `run-start` 之前

规格 §8：取消检查、阶段改成 `started`、发出 `automation/run-start` 三者之间不能 `await`，并用注释钉住。

计划 Task 7 把注释结束标在 `entry.phase = 'started'` 之后，发射留在「原有逻辑」。按当前源码，`executeRun` 的第一次 `await` 在发射之后的 `markAutomation`，粘贴后的行为仍然是同步的。注释划错了范围。以后若有人按注释在发射前插入 `await`，就会重新打开这段窗口。

处置：把同步段结束标记移到 `routeCtx.emit` 的 `run-start` 之后。

### 4. Task 7 的预置取消测试和入队实现互相拆掉

`dispatchEnqueue` 入队时总会写入一条 `cancelRequested: false` 的新记录。Task 7 要求先预置 `cancelRequested: true`，再对同一个 `runId` 入队。这次入队会把标记盖掉，测试无法证明执行体会看到取消。

处置：跳过用例改成 Task 8 已有的顺序：先入队，再停止，然后让执行体醒来。

## 不挡实施的引用错误

### 5. `routes.ts` 不在 64 条声明差异里

计划 Global Constraints 写 `routes.ts` 属于 M9 后 64 项分叉。`scripts/verify-desktop-variants.mjs` 里，`src/huaanwork-host/` 是单侧前缀，`routes.ts` 因此不占 `allowedDifferences`。已占名额的是 `src/electron-shell-generation.ts`。

两边都不用新增白名单条目。`will-download` 挂在 `mount()` 第 341 行之后的 `renderer` 上，那里的值是 `WebContents`。不要挂在第 319 行刚构造的 `BrowserWindow` 上。`BrowserWindow` 没有 `.session`。

## 结论

规格维持终审通过，正文不用为这次计划评审改行为。计划在改完第 1–4 条之前不要开始写代码。第 1 条是改开口项的处置，不是改规格里「注册表写入可以异步」那句。
