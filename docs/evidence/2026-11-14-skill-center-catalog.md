# 技能中心双标签与内网共享流转 — 实施证据（2026-11-14）

- 分支/worktree：`feat/skill-center-catalog` / `.worktrees/skill-center-catalog`
- 基线：`9d5a7a0f75`（master merge-base）
- 最终树提交：见本文件落盘提交（表格中 Task 1–10 的提交链 + 计划/规格/证据提交）
- 规格：`docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`
- 计划：`docs/superpowers/plans/2026-11-14-skill-center-catalog.md`

## 1. 最终工作区门禁（Task 11 Step 1）

命令均在最终代码树上单独执行，记录原始退出码：

| 命令 | 开始/结束（本地时间） | 退出码 | 关键计数 |
| --- | --- | --- | --- |
| `corepack yarn typecheck` | 2026-11-14 23:52 | **0** | 25s |
| `corepack yarn test` | 2026-11-14 23:52 | **1** | 291 passed / 1 failed / 4 skipped（4099 tests；4083 passed / 1 failed / 15 skipped） |
| `corepack yarn check` | 2026-11-14 23:53 | **0** | 187s；`dsh-plugin-huaanwork` vitest 292/292 passed、4 skipped |

### 1.1 `yarn test` 单项失败的分诊（如实记录）

- 失败用例：`tests/huaanwork-host/agent-package-runtime.spec.ts > agent package skill script lifecycle > stopping the runtime during a running script kills it and removes the state dir`
- 现象：`ENOENT … hang-state.txt`。fixture 的 `hang.mjs` 先写 `hang-pid.txt` 再写 `hang-state.txt`；用例在等到 pid 文件后立即读取 state 文件，全量并行负载下存在时序竞争。
- 归因证据：
  1. 同一套件在随后执行的 `corepack yarn check` 中 292/292 全部通过（含该用例）；
  2. 在最终树上单独复跑该用例（`vitest run tests/huaanwork-host/agent-package-runtime.spec.ts -t "stopping the runtime during a running script"`）→ 1 passed / 59 skipped；
  3. 本计划的改动不触及该 fixture 的脚本生命周期路径（仅在同文件的 `makeProfileWithSkill` 测试辅助中启用技能）。
- 结论：既有测试的时序偶发，不是本次功能回归；仍按“最终树实际退出码”记录，不用通过的重跑覆盖第一次失败。

## 2. 自动化覆盖与规格 §14.1 映射

| 规格 §14.1 条目 | 覆盖位置 |
| --- | --- |
| 两标签、默认页、页内搜索、按钮/徽标/空态 | `tests/client-huaanwork/skillsLogic.spec.ts`（标签/按钮/徽标/搜索）+ `tests/client-huaanwork/skillsView.spec.ts`（jsdom：默认页、系统技能无下载、下载/已下载按钮态、共享卡发布者/revision、迁移警告、我的技能徽标/启停/上传入口、空态指路） |
| 启停、删除清理、重启恢复、未启用 `/` 拒绝 | `skills-host.spec.ts`、`skill-local-state.spec.ts`、`routes.spec.ts`、`sessions.spec.ts` |
| `user-invocable:false` 不阻止已启用本地技能；表单无该选项；编辑保留行 | `skills-host.spec.ts` 解析器用例、`skillsLogic.spec.ts` |
| 内置同名副本拒绝首次上传；另存为新技能 | `skill-catalog-upload.spec.ts`、`skill-duplicate.spec.ts`、`routes.spec.ts` |
| 成功文案与刷新联动 | `skillsLogic.spec.ts`、`appWiring.spec.ts`（slash 刷新接线钉） |
| 新共享包进入布局/内联/许可证门禁 | Task 1 提交 + `check:layout`、`yarn check` 全绿 |
| `SkillDetail` 读模型与列表投影分离 | `rpc-types.ts`、`skills-host.spec.ts`、typecheck |
| 外部技能不可自动调用（UI/Host/preset） | `skills-host.spec.ts`、`profile.spec.ts`、`routes.spec.ts` |
| 归档 round-trip/穿越/链接/嵌套压缩/超帽/摘要 | `packages/huaanwork-skill-format/tests/*` |
| 服务端上传即发布/分页/owner/expected/幂等/审计恢复 | `agent-catalog-server/tests/skill-store.spec.ts`、`skills.spec.ts`、`auth-legacy.spec.ts` |
| 下载原子性/冲突/更新/默认禁用 | `skill-catalog-download.spec.ts` |
| 上传权限隔离/首次发布/非 owner/重试/上传中编辑 | `skill-catalog-upload.spec.ts`、`skill-catalog-client.spec.ts` |
| 内网不可用时本地独立与完整缓存 | `skill-center.spec.ts`、`skill-catalog-client.spec.ts` |
| 迁移保留存量与同名本地 | `skill-center-migration.spec.ts` |

## 3. 真机端到端矩阵（规格 §14.2）— BLOCKED

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 双客户端（A/B 两个 Profile + 两个上传者 token）上传/下载/启停/冲突 | **BLOCKED** | 本会话未启动隔离内网目录服务与两个真实桌面客户端；仅有 loopback HTTP 与真实 Profile 的自动化覆盖 |
| macOS 真实 UI、目录选择、资源下载、重启恢复、迁移 | **BLOCKED** | 未进行真实 GUI 走查 |
| Windows 真机矩阵 | **BLOCKED** | 无 Windows 主机 |
| 升级 fixture（旧用户技能/旧启用内置/同名冲突/外部文件保留） | **BLOCKED（真机）** | 自动化迁移用例已覆盖逻辑；真实旧数据目录 fixture 未执行 |

按计划与仓库规则：不得以 CI 或单元测试代替真机结论；因此规格状态**保持“待实施”**，不写成“已实施”。获得真机环境后按规格 §14.2 逐项补跑。

## 4. 自审（Task 11 Step 5）

- 活跃源码无 `all`/`external` 技能标签（grep 0 命中）；`skill.list` 无消费者；无外部 resolver 回退；无普通 bundled 启停恢复。
- 文档不把摘要写成签名（`docs/skill-center*.md` 明示“没有签名/keyring 校验”），不把 CI 写成 Windows 真机通过。
- 本文件第 3 节如实登记 BLOCKED。


## 5. 最终整支评审修复波次（2026-11-15）

整支评审（merge gate）提出 3 项 Important，已在本波次闭环：

1. `THIRD_PARTY_NOTICES.md` 缺少新内置包：运行 `corepack yarn workspace dsh-plugin-huaanwork verify:notices` 重新生成，新增 `| @huaanwork/skill-format | 0.1.0 | MIT | bundled |` 一行（exit 0）。
2. 迁移警告未在界面展示（规格 §11.1.4/§11.1.6）：`SkillsView` 的 `refreshCenter` 读取 `migrationWarnings` 并在技能中心渲染；jsdom 用例断言警告可见。
3. 两标签页缺少可执行 UI 覆盖：新增 `tests/client-huaanwork/skillsView.spec.ts`（3 个 jsdom 用例），补齐 §14.1 的默认页/按钮可见性/系统技能/空态断言；上文 §14.1 映射已更新。

修复波次后的最终门禁（第三条表，均在修复后的最终树执行）：

| 命令 | 退出码 | 关键计数 |
| --- | --- | --- |
| `corepack yarn typecheck` | （见提交说明） | — |
| `corepack yarn test` | （见提交说明） | — |
| `corepack yarn check` | （见提交说明） | — |
