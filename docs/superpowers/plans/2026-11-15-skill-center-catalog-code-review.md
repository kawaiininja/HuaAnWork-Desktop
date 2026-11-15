# 技能中心双标签与内网共享流转 Code Review（复核与终检闭环版）

- **日期：** 2026-11-15
- **审阅目标：** 分支 `feat/skill-center-catalog`（worktree `.worktrees/skill-center-catalog`，当前 HEAD `93351296d3`，相对基线 `9d5a7a0f75` 共 44 个提交；其中复修阶段相对初审提交 `e95980f517` 新增 8 个提交 `5856463048`..`93351296d3`）
- **变更规模：** `95 files changed, 12892 insertions(+), 1146 deletions(-)`（复修增量 `15 files changed, 492 insertions(+), 43 deletions(-)`）；上游子模块 `deepseek-harness/` 零修改
- **对照依据：**
  - 规格文档：`docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`（含第 4 行记录的 `R-ACCEPT-1` Windows 真机验收豁免）
  - 实施计划：`docs/superpowers/plans/2026-11-14-skill-center-catalog.md`
  - 验收证据：`docs/evidence/2026-11-14-skill-center-catalog.md`
- **初审结论（`e95980f517`）：** With fixes
- **终检结论（`93351296d3`）：** **Approved（复修后全量门禁与单测全部通过；残余项均为非阻塞 Minor 备注，Windows 真机仍按 `R-ACCEPT-1` 记 waiver）**

> 说明：除明确标注根仓基线外，本文档中的所有代码路径、行号与提交哈希均指 worktree `.worktrees/skill-center-catalog` 上的真实代码状态。

---

## 一、Double-Check 与复议校准结论

### 1.1 第一轮评审复核校准（`e95980f517` 落盘前）

| 类别 | 原审观点 | 复核事实与依据 | 校准后处理 |
| --- | --- | --- | --- |
| **误报清除** | 怀疑 `packages/huaanwork-skill-format/src/archive.ts` 允许空 `description` 发布 | 服务端 `agent-catalog-server/src/skill-store.ts:288-297` 发布校验已强制 `description.trim() !== ''` 及 `publisher`、`digest`、`createdAt` 非空（抛 `SkillStoreError('invalid-skill', ...)`，由 `agent-catalog-server/src/skills.ts:223-225` 映射 HTTP `400`）；桌面 Host `skills-host.ts:231` 亦强制非空 | **移出问题清单**，不作为缺陷报告 |
| **夸大与失实修正** | 称 `previewSkillImport` 跳过「符号链接、硬链接、256 条目数和 5 MiB 体积上限检查」 | **“跳过符号链接”不实**：`skills-host.ts:504, 511`（`e95980f517` 为 `:499, 506`）已通过 `stat.isSymbolicLink()` 和 `containsSymlink(sourcePath)` 明确拒绝符号链接。实际推迟到确认导入时才由 `readSkillDirectory` 拦截的是硬链接（`nlink > 1`）、非普通文件、保留前缀段、路径字节上限、256 条目与 5 MiB 上限 | 删除“跳过符号链接”失实表述；从安全缺口校准为 **Important #4**（预览/确认规则不一致 + 弹窗交互测试覆盖不足） |
| **修复约束补充** | 仅建议把 `listLocalRoot` 改为按磁盘文件现算 `contentDigest` | `skill-catalog-download.ts:195-207, 247-254` 中的 `onDiskDigestMismatch` 消费 `listUserSkills` 返回的 `local.contentDigest`。若只改 `listLocalRoot` 返回磁盘摘要而不同步修改 `onDiskDigestMismatch`，会退化为“磁盘与自身比对（恒为 `false`）”，漏掉改回与远端相同字节的带外修改 | 在 **Important #1** 中补充联动修改 `onDiskDigestMismatch` 读取持久化 `readSkillLocalState` 摘要的约束 |
| **基线归因核查** | `ImportPickModal` 点击“选择 .md 文件”实调 `pickDirectory()` | 经 `git show 9d5a7a0f75:dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx` 比对，`pickImport(_directory)` 忽略参数在基线已完全一致存在，属既有 UI/选择器限制 | 不计为本次回归，仅在 **Minor #4** 附注 |

### 1.2 复修阶段再复议（`93351296d3`）

针对开发者（qwen4）提出的 **2 项评审分级/误报复议** 核实如下，结论均**支持开发者判断**：

1. **`Minor 3` 第一条（`skill-duplicate.ts:69-81` 未检本地状态前先落盘）—— 确认为误报，未采纳合理：**
   - 经追查完整调用链，`skill-duplicate.ts:69-76` 在 `withSkillStorageLock` 持锁块内先调用 `takenNames(profileDir)`（`:71`）。
   - `takenNames`（`skills-host.ts:220-225`）内部调用 `listUserSkills` → `listLocalRoot`（`skills-host.ts:118-120`），在首两行即读取并校验 `readUserSkillToggles(root)` 与 `readSkillLocalState(root)`。
   - 若任意状态文档损坏，`takenNames` 在第 71 行便会先于 `stageSkillDirectory`（`:77`）抛出 `CorruptUserSkillTogglesError` / `CorruptSkillLocalStateError`，与 `createSkill`/`importSkill` 的真实前置检查语义等价，**确属初审未展开 `takenNames` 调用链造成的误报**。
2. **`Important 2`（`skill-center.ts` `downloadStateOf` 摘要相等优先于更高 `revision`）—— 降级为 `Minor` 合理，且代码已稳妥修复：**
   - 该问题仅在“服务端先发布新版、再回滚至完全相同旧内容得出更高 revision（如 `A → B → A`），且用户停留在未改动的 rev 1”这一少见序列触发；触发时磁盘文件与服务端最新内容逐字节一致，无功能缺失、无静默覆盖、无上传预期版本污染（上传取 `publishedRevision`），且后续新 revision（`C`）会自动恢复 `update-available`。原定为 Important 偏重，归类为 **Minor** 合理。
   - 值得肯定的是，开发者在提出降级的同时已在提交 `4a72195395` 中将 `skill-center.ts` 与 `skill-catalog-download.ts` 两侧一并修完并补齐测试。

---

## 二、逐项问题闭环核查表

| 编号 | 级别（校准后） | 核心问题 | 解决提交与代码核验 | 状态 |
| --- | --- | --- | --- | --- |
| Important 1 | Important | 带外磁盘编辑在“我的技能”和“技能中心”不可见（需同步解除 `onDiskDigestMismatch` 耦合） | `5856463048`：`skills-host.ts:130-145` 对 `listLocalRoot` 现算 `skillEntryDigestLenient`；`skill-catalog-download.ts:195-207` 改用 `readSkillLocalState` 对比；`skills-host.spec.ts` / `skill-center.spec.ts` / `skill-catalog-download.spec.ts` 补 4 条回归测试 | **已关闭** |
| Important 3 | Important | 删除与另存为弹窗报错被遮罩挡住，且 `confirmImport` 缺 `modalBusy` 防重入 | `eedbcade6c`：`SkillsView.tsx:41-44, 184-252, 461-485, 661-788` 为 3 个弹窗接入 `modalError` 内显与 `modalBusy`/`disabled={busy}`，并新增 `skillsView.spec.ts` 4 条弹窗失败与防重入测试 | **已关闭** |
| Important 4 | Important | 导入预览与确认导入校验边界不一致 + `skillsView.spec.ts` 缺交互用例 | `39f6b034bc` + `eedbcade6c`：`skills-host.ts:512-522` 预览调用 `readSkillDirectory` 返回结构化 `fieldErrors`；更新 `skill-local-state.spec.ts` 与新增 `skills-host.spec.ts` 6 条预览边界测试；`skillsView.spec.ts` 增至 8 个用例 | **已关闭** |
| Minor 1（原 Important 2 归并重排 / 规格张力） | Minor | ① `downloadStateOf` / `sameSource` 同摘要高 `revision` 更新掩盖；② `SKILL_CATALOG_UNAVAILABLE` 掩盖 `'auth'` / `'page-limit'` 报错 | ① `4a72195395`：`skill-center.ts:164-174`、`skill-catalog-download.ts:218-222` 已修复并附 2 条回滚测试。<br>② `1b7c7b793d`：`skill-center.ts:50-56, 196-200` 保留 `'unreachable'` 使用 `SKILL_CATALOG_UNAVAILABLE`，单独透出 `'auth'`（如真实运行态由 `catalog-transport.ts:157` 抛出的 `'目录口令错误或权限不足'`）与 `'page-limit'` 并补齐测试 | **已关闭** |
| Minor 2 | Minor | `markdown.ts` 无尾随换行闭合 `---`/空 frontmatter/CRLF `extraLines` `\r` 保留 | `48585a2c1a`：`markdown.ts:54-62` 放宽 EOF 与 CRLF 归一化并补 3 条测试（残余 1 处极边缘“空 frontmatter + 正文水平线 `---`”贪婪量词备注见第三节） | **主体已关闭（见残余备注 #1）** |
| Minor 3 #1 | **误报清除** | 原疑 `skill-duplicate.ts:69-81` 未先读本地状态即 `stageSkillDirectory` | `takenNames(profileDir)` 已在锁内优先调用 `listLocalRoot` 完成双状态文件校验（详见 §1.2） | **误报清除** |
| Minor 3 #2 | Minor | `skill-catalog-upload.ts:86-95` 进锁后基于锁前 `local` 快照合并写回 | `f59b20b5b9`：在 `withSkillStorageLock` 内重读 `readSkillLocalState(profileDir).skills[name]` 后再合并字段 | **已关闭** |
| Minor 4 | Minor | `SkillsView.tsx` 编辑保存后固定提示“请启用”且未即时刷新 `onInvocableChanged` | `eedbcade6c`：`SkillsView.tsx:453-458` 区分 `editing` 文案并调用 `onInvocableChanged?.()`，附 `skillsView.spec.ts` 用例验证 | **已关闭** |
| Minor 5 | Minor | `listLocalRoot` 未对同根同名 `.md` 文件与目录包去重 | `5856463048`：`skills-host.ts:122, 128-129` 新增 `seen` 去重与 `skills-host.spec.ts` 回归测试 | **已关闭** |
| Minor 6 | Minor | `docs/README*.md` 未收录 `docs/skill-center*.md`；Windows 语义待真机验证 | `93351296d3`：`docs/README.md` 与 `docs/README.en.md` 均已补齐目录索引，双语门禁通过；Windows 边界继续按 `R-ACCEPT-1` 记 waiver | **文档已关闭（Windows 按 waiver 跟踪）** |

---

## 三、终检残余备注（Residual Minor，非阻塞）

在本轮复修后的终检中，代码与测试整体实现质量扎实，未发现任何阻塞合入或发布的问题；仅记录以下 3 处低风险细节供后续酌情微调或文档对齐：

1. **空 frontmatter 紧接正文 `---` 分割线时的正则贪婪匹配（`packages/huaanwork-skill-format/src/markdown.ts:55`）：**
   `48585a2c1a` 采用 `/^---\r?\n((?:[\s\S]*?\r?\n)?)---(?:\r?\n([\s\S]*))?$/u`，其中外层可选量词 `?` 为贪婪模式而非惰性 `??`。经节点实测 `'---\n---\nhello\n---\nworld'` 会匹配成 `['---\nhello\n', 'world']`，把首段正文吞入 `extraLines`。仅影响“frontmatter 完全为空（无 `name`/`description`）且正文带 Markdown 水平线 `---`”的非法/极边缘文档；后续若顺手改为 `((?:[\s\S]*?\r?\n)??)` 即可根除。
2. **界面 `busy` 状态按单值阻塞无关技能卡片（`dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx:54, 121, 142, 163`）：**
   Host 侧下载锁已按 `profileDir:source:name` 隔离，卡片按钮也按 `busy === key` 禁用，但组件内 `busy` 为单值 `string | null` 且操作函数开头统一写 `if (busy) return;`，导致某一技能请求在途时，点击无关技能卡的下载/上传/启停会静默返回（略偏离规格 §12 第 447 行“不阻塞无关技能”描述）。无状态损坏风险，后续按需改为按 key 维护集合即可。
3. **证据文档终态数据建议同步（`docs/evidence/2026-11-14-skill-center-catalog.md:92-99`）与 `R-ACCEPT-1` Waiver：**
   当前证据文档的第三张门禁表停留在 `e95980f517` 波次计数（`4087 passed`）；本轮复修新增的 24 条测试（桌面 `+21`、格式包 `+3`）已通过全仓门禁验证（见第四节）。合入或归档前可将第四节数据同步追加至证据表；Windows 真机矩阵依规格第 4 行与证据文档 §6 的 `R-ACCEPT-1` waiver 执行。

---

## 四、终检实跑全量验证记录（`HEAD 93351296d3`）

以下三条根目录门禁均在 `.worktrees/skill-center-catalog` 当前最终提交 `93351296d3` 上按计划 §Global Constraints 顺序独立执行（无并发 `verify:aa`），全部退出码 **`0`**，且执行后工作树干净（`git status --short` 为空）：

| 命令 | 退出码 | 实测关键计数与门禁详情 |
| --- | --- | --- |
| `corepack yarn typecheck` | **`0`** | 全仓 9 个 TypeScript 项目通过；`contract-types: 4 generated type files are current` |
| `corepack yarn test` | **`0`** | 全部 13 个 workspace 零失败：<br>• `dsh-plugin-huaanwork`: `293 passed \| 4 skipped (297)` files，`4108 passed \| 15 skipped (4123)` tests<br>• `dsh-community-market`: `13 passed (13)`，`303 passed (303)`<br>• `@huaanwork/policy`: `64`（`62 pass / 2 skipped`）；`@huaanwork/model`: `10`；`@huaanwork/git-tools`: `8`；`@huaanwork/web-tools`: `19`<br>• `market-server`: `14` files / `244` tests；`update-server`: `5` files / `88` tests<br>• `@huaanwork/catalog-signing`: `13`；`@huaanwork/agent-package-format`: `35`；`@huaanwork/skill-format`: `50 passed`<br>• `agent-catalog-server`: `7` files / `112` tests；`agent-catalog-admin`: `15` |
| `corepack yarn check` | **`0`** | 含完整 `build`、全仓 `typecheck` & `test` 与全部静态/运行门禁：<br>• `verify-bilingual-docs: 51 records and 102 documents are consistent`<br>• `verify-market-dependency-direction: 457 tracked source files ...; 8 market wrapper files ...`<br>• `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified`<br>• `verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1`<br>• `verify-readme-versions: 4 hardcoded artifact version string(s) in 1 scoped package(s) (dsh-plugin-huaanwork)`<br>• `verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.`<br>• `verify-bundled-runtime: 134 files checked; 10 bundled packages are inlined; tar is compiled into lib`<br>• `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`<br>• `verify-licenses: 637 packages checked (10 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`<br>• `verify-operation-reliability: 7 operations and 18 fault contracts verified.`<br>• `verify-aa`、CLI/Loader smoke 全部通过 |

**平台/环境跳过项与豁免说明（如实记录）：**

- `dsh-plugin-huaanwork` 中的 4 个文件（15 条测试）跳过为既有的 macOS 宿主/实网环境门控（`windows-console-host.spec.ts`、`host-liveness-win.spec.ts`、`huaanwork-migration-smoke.spec.ts`、`huaanwork-host/market-smoke-live.spec.ts` 及平台条件用例）；`@huaanwork/policy` 中的 2 条跳过同为平台门控。
- Windows 真机安装与交互矩阵仍依规格第 4 行记为 `R-ACCEPT-1` waiver，待取得 Windows 主机时按 `docs/evidence/2026-11-14-skill-center-catalog.md` §3 矩阵补跑验证。

---

## 五、残余处置（2026-11-15 owner 裁定「同意」后实施）

owner 对第三节三项 Residual Minor 的裁定：**#2 修、#3 补、#1 登记不修**。

| 项 | 裁定 | 处置 |
| --- | --- | --- |
| Residual 1（正则贪婪） | **不修（YAGNI）** | 经节点实测：仅影响空 frontmatter（无 name/description）且正文带 `---` 水平线的**非法**文档，这类文档无论解析结果如何都被 `validateSkillFields` 拒绝；合法技能（含正文水平线）解析完全正确。建议的 `?`→`??` 修法验证正确且零风险，但无真实用户场景，登记为可选洁癖项，不在本轮修。 |
| Residual 2（busy 单值阻塞） | **已修** | 提交 `5a77d0e5f2`：`SkillsView` 的 `busy` 由单值 `string \| null` 改为按 key 的 `ReadonlySet<string>`，download/upload/toggle 早退与三处按钮禁用统一改 `busy.has(key)`，与 Host 按 key 的下载锁对齐，落实规格 §12「不阻塞无关技能」。基线核查：`if (busy) return` 早退为本轮 Task 9 重写新引入（基线 `9d5a7a0f75` 无此模式）。补 2 条 jsdom 钉（无关技能启停不被阻塞 + 同技能在途按钮禁用）。 |
| Residual 3（证据计数过期） | **已补** | `docs/evidence/2026-11-14-skill-center-catalog.md` §5 追加复修 + 残余波次的终态门禁计数（见该文档新增小节）；Windows waiver 维持 §6 不动。 |

处置后 HEAD：`e9f62cd0fa`（feat/skill-center-catalog，未 push；门禁实跑于 `5a77d0e5f2`，其后 only 文档提交）。终态门禁退出码见证据文档 §5.1。
