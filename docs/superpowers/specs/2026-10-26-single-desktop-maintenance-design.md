# HuaAnWork 单桌面、单代码维护两阶段设计

> 状态：2026-10-26 设计已获用户批准；2026-10-29 按复核意见修订，待实施计划。
> 实施分支：开工时新建 `refactor/huaanwork-single-desktop-maintenance`；旧名 `refactor/huaanwork-single-desktop` 已随 PR #21 的合并历史使用，不续用。
> 基线：`b5ef3e84a7951941480b50a8749fe6714b8c9fc7`（2026-10-29 复核时的 master HEAD；实施计划开工时须再次重钉）。

## 1. 背景与问题

仓库当前有四个桌面源码树：

| 目录 | 角色 | 当前验证与发布形态 |
| --- | --- | --- |
| `dsh-plugin-desktop/` | Stable | 根检查及 Windows、macOS、Linux CI |
| `dsh-plugin-desktop-beta/` | Beta，HuaAnWork 的衍生基线 | 根检查及 Windows、macOS、Linux CI |
| `dsh-plugin-huaanwork/` | HuaAnWork | 根检查、Windows/macOS CI 和正式发布流程 |
| `dsh-desktop-next/` | 独立实验壳 | 根检查与 Next 专项验证，无发布流程 |

根 workspaces、`build`、`typecheck`、`test`、`check`、运行时准备和 CI 仍同时维护四套源码。`release.yml` 的发布产物已经只有 HuaAnWork，但其根发布命令仍会经过多桌面的 market 和 AA 准备逻辑。

静态依赖调查未发现 HuaAnWork 运行时依赖另外三个桌面包。真正的耦合位于：

- 根 workspaces、脚本和门禁；
- `prepare-dsh-market.mjs` 与 `agents-anywhere-release-policy.mjs` 的四桌面清单；
- variant 守卫和跨桌面测试；
- CI 矩阵与 Next 专项步骤；
- 对上游整仓合并的同步方式。

因此，目标不是给 HuaAnWork 解一次 import，而是分阶段改变仓库的活跃产品边界和上游同步模型。

## 2. 已确认决策

1. **两阶段实施**：先做方案 A，阶段 A 完整验证通过后再做方案 B。
2. **阶段间硬门禁**：阶段 A 必须通过本地完整无头检查、macOS unsigned smoke 打包及 Windows/macOS 分支 CI，才能开始删除目录。
3. **最终单套桌面**：阶段 B 删除 Stable、Beta、Next 三个桌面源码树，只主动维护 `dsh-plugin-huaanwork/`。
4. **保留上游输入**：阶段 B 后保留 outer desktop upstream remote，但改为选择性移植，不再整仓合并三个已删除的桌面树。
5. **分支提交与 CI**：允许在独立分支按设计文档、阶段 A、阶段 B 提交并推送，以 `workflow_dispatch` 运行 CI；不直接推 master，不自动合并或发布。
6. **兼容性不清零**：历史产品 ID、旧数据迁移兼容字符串和历史证据文档不属于额外桌面实现，不做无收益的字符串清洗。

## 3. 方案比较

### 3.1 两阶段收敛，采纳

阶段 A 先停用另外三套的所有活跃入口并验证，阶段 B 再删除目录和切换上游模式。多一轮配置验证，但可以把“门禁改造问题”和“物理删除问题”分开，并保留明确恢复点。

### 3.2 一次性原子删除，不采纳

配置只需改一遍，但依赖问题、测试变化和删除问题会混在一起，无法满足阶段 A 验证通过后才进入阶段 B 的要求。

### 3.3 阶段 A 先移动参考目录，不采纳

把参考树移动到 `reference/` 可以更醒目地表达状态，但会提前制造上游路径冲突，并增加没有产品收益的路径改动。阶段 A 保持参考目录原路径和 tracked 内容不变。

## 4. 最终架构边界

最终仓库只有 `dsh-plugin-huaanwork/` 一个自有、可编辑的活跃桌面源码树；只读上游子模组不计入自有实现数量。以下输入不是另外的桌面产品，继续保留：

- `dsh-community-market/` 及 HuaAnWork 使用的 contracts；
- `dsh-community-fabric/` 的社区互操作 RFC 文档骨架；继续作为 workspace 参与根 `check`，不声明可加载入口；
- `market-server/`、`update-server/`、`agent-catalog-server/`、`agent-catalog-admin/`；
- `packages/` 下的 `@huaanwork/*` 与签名、包格式模块；
- `vendor/dsh-runtime/` 中仍有消费方的运行时制品；
- `vendor/agents-anywhere/` 及 AA bridge；
- `deepseek-harness/` 只读子模组，包括 macOS entitlements 来源和运行时再生能力；
- 根补丁、lockfile 和必要的共享脚本。

最终“单代码维护”指单一桌面实现和单一活跃变体，不要求仓库只剩一个 workspace，也不要求删除历史产品标识。

## 5. 阶段 A：HuaAnWork 成为唯一活跃桌面

### 5.1 参考树不变

阶段 A 不修改以下目录中的 tracked 文件：

- `dsh-plugin-desktop/`
- `dsh-plugin-desktop-beta/`
- `dsh-desktop-next/`

它们暂时保留为对照和回退参考，但不再是活跃 workspace，不再参与日常构建、测试、打包或版本刷新。参考目录中的旧依赖 pin 不再代表受支持构建的新鲜度。

### 5.2 根入口与 CI

- 从根 workspaces 移除三个参考桌面包。
- 根 `build`、`typecheck`、`test`、`check` 只检查 HuaAnWork 和仍需保留的非桌面 workspaces。
- 无后缀 `dev`、`start`、`package:dir`、`dist:mac*`、`dist:win*` 改为 HuaAnWork；移除 Stable、Beta、Next 的活跃命令。
- HuaAnWork 没有 Linux 发行线，因此移除 Stable 的根 Linux 命令以及 Stable/Beta 的 Linux CI job 及其矩阵，不新增虚假的 HuaAnWork Linux 验证。
- CI 删除 Stable/Beta 矩阵和 Next 专项步骤；AA-skip 处理只修改 HuaAnWork。
- 分支 CI 通过既有 `workflow_dispatch` 触发，不为了本项工作放宽成分支 push 自动运行。

### 5.3 工具链和依赖归属

- `market:prepare` 只刷新 HuaAnWork，相关 fixture 和测试同步调整。
- AA 准备只读取和验证 HuaAnWork；受影响的 artifact、provenance、manifest 与 lockfile 按现有 AA 纪律一起更新。
- `verify-layout.mjs` 改为单活跃桌面拓扑，不再读取或验证参考包。
- `activeChannel` 改为 `huaanwork`，`check:vendored-runtime` 只检查该通道。
- `dsh-community-market` 的 DSH 依赖同步与校验归属从 Beta 改为 HuaAnWork；阶段 A 保留三通道，现有 market peer range 的构造及值不变，已解析运行时版本不变；其旧通道派生逻辑在阶段 B 按 §7.1 处置。
- 多桌面 variant 守卫、漂移分类和仅供 Stable/Beta/Next 使用的工具退出活跃门禁；根测试 glob 不得暗中继续执行这些参考工具。
- Stable/Beta/Next 的通用图标导出检查退出根门禁。HuaAnWork 继续使用自己的 `generate-mac-app-icon.mjs`、`gen-windows-ico`、托盘生成和包测试，不复制一套不需要的新图标流水线。
- HuaAnWork 包测试中读取 Stable/Beta 清单、图标和旧 CI 矩阵的断言改成单产品结构与行为断言。
- 根说明和 Agent 规则改成单一活跃桌面。将 `AGENTS.md` 流程段及活债表中涉及 Stable/Beta/Next、variant 守卫和跨包读取的条目逐行标记为“关闭 / 改写 / 保留”，其余债项确认保留；不得以“历史文档保留”为由留下指向已退役命令的活规则。指向已退役命令、门禁和跨包读取的规则随阶段 A 改写；zero-touch 等参考目录保护规则在阶段 A 继续有效，阶段 B 删除目录后关闭。阶段 A 仍不修改参考树 tracked 内容。历史设计和证据文档保留原貌。

### 5.4 阶段 A 的行为约束

- 不改变 HuaAnWork 产品功能、界面、数据格式或更新协议。
- 不推进 `deepseek-harness` 子模组 pin。
- 不为减少 diff 而绕过 market、AA 或运行时检查的 fail-closed 规则。
- 根 lockfile 通过包管理器重解，不手工拼装。

## 6. 阶段 A 进入阶段 B 的硬门槛

阶段 A 提交后记录精确 SHA，依次取得以下证据：

1. `corepack yarn install --immutable`
2. `corepack yarn check`
3. `corepack yarn typecheck`
4. `corepack yarn test`
5. 本机 `corepack yarn dist:mac-smoke:huaanwork`；仅当该检出的 provisioning 守卫仍有缺项时，允许使用 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1 corepack yarn dist:mac-smoke:huaanwork`
6. 推送阶段 A 分支，在该 SHA 上手动 dispatch 完整 CI，所有保留 job 成功，包括 Windows installer/portable 与 macOS 打包

证据口径：

- Windows 证据是现有 CI 的打包与运行时检查，不声称真实第二台机器或跨机器验收已经通过。
- macOS 证据是 unsigned smoke，不声称签名或公证已经通过。
- provisioning 证据须记录守卫结果、是否使用上述豁免及当时缺项；使用豁免时只能写 unsigned / unprovisioned smoke，不得写成已完成 provisioning 或可发行。静态守卫通过不等于内网部署交付或 origin 可达性验收。
- 任何一项失败都停留在阶段 A；修复后重新验证受影响门禁，不用阶段 B 的删除掩盖问题。
- 只有阶段 A SHA、CI run 和本地验证结果落盘后，才允许开始阶段 B。

## 7. 阶段 B：物理单套与选择性上游移植

### 7.1 删除与依赖清理

- 从已验证的阶段 A SHA 继续，删除三个参考桌面目录。
- 清理剩余专用脚本、测试、workspace/CI 引用和失效规则。
- 在删除 Stable/Beta 通道元数据或执行任何 `sync-vendored-runtime.mjs --write` 前，先裁定并改造 `dsh-community-market` 的 peer range 政策：活跃 HuaAnWork runtime 必须被覆盖；Stable 历史腿与 dormant alpha.1 腿分别按消费方证据决定保留或退役；保留历史腿时改为显式政策字段或常量，不得继续从待删除通道推导。同步更新构造、测试和验证。此项是删除旧通道元数据的前置门，不阻断阶段 B 的调查和其他清理工作。
- `upstream.json` 只保留 HuaAnWork 活跃通道。
- 对旧 runtime resolutions、`vendor/dsh-runtime/` 和 `patches/` 先做消费方扫描；只删除证明无消费方的条目和资产。
- 重新生成 lockfile，并验证市场、AA 和 HuaAnWork 的运行时闭包。
- 保留历史产品 ID、旧数据迁移逻辑、不可变 bundle 识别及历史文档中的旧包名。

### 7.2 新的 outer desktop upstream 审阅基线

新增机器可读的 `desktop-upstream.json`，至少记录：

| 字段 | 含义 |
| --- | --- |
| `repository` | 固定的 outer desktop upstream 仓库 |
| `reviewedCommit` | 已完成处置的上游审阅基线 |
| `sourcePackage` | 用于对照 HuaAnWork 的主要上游桌面包路径 |
| `watchedPaths` | 需要逐提交处置的 outer Desktop 路径，覆盖根共享接线及 Stable/Beta/Next，避免只盯主要对照包而漏掉相关修复 |

初始 `reviewedCommit` 取阶段 B 开始时最后一次完整合并所对应的上游 SHA，通过当时的 Git 历史计算，不取最新 tip，避免把未处理提交静默标记为已审阅。

改造现有 `scripts/upstream-sync-dashboard.mjs`：

- 移除对 variant 守卫 `PAIRS` 的 import、三包 `src/` 磁盘扫描及对应报告面，不让这些已退役能力在参考目录缺失后静默退化为空报告；
- 按 `reviewedCommit..upstream/master` 报告待审提交和触及文件；
- remote 或 ref 缺失时明确失败，不静默输出零；
- 不再用 merge-base 落后量表示选择性移植后的未处理量，因为移植提交不形成祖先关系；
- 保留 as-of 时间和完整 SHA 的报告纪律。

每批上游处置在 `docs/evidence/` 记录“已移植”或“不移植及理由”以及对应 upstream SHA。需要的改变进入 HuaAnWork，不再整仓合并 Stable/Beta/Next。只有整批提交都完成处置后才推进 `reviewedCommit`。

三包 variant 守卫和 dashboard Scope B 随参考树删除退役后，fork 内三包同形与漂移的机器核对随之消失。`watchedPaths` 和处置证据只提供上游覆盖与分诊，不验证移植的完整性或等价性；`docs/upstream-sync.md` 必须明示这层“由机器核对转为人工逐提交处置”的能力变化，避免后人误补已失去比较对象的三包守卫。若需要移植等价性的机器验证，须另行设计。

实施计划的排期以 `reviewedCommit..upstream/master` 的首期实际货架实测为准，逐提交、逐文件列出移植或跳过裁定。既有功能对齐欠账中的“新增 15 + 合并 25”只描述存量差异，历史整仓冲突数和 runtime 补丁重锚人日也只作背景参照，不得直接换算为首期选择性移植工作量。

`deepseek-harness` 的运行时更新与 outer desktop 的选择性移植保持两条独立证据链，子模组 pin 仍单独提交。

### 7.3 阶段 B 验证

重复阶段 A 的完整验证：

1. `corepack yarn install --immutable`
2. `corepack yarn check`
3. `corepack yarn typecheck`
4. `corepack yarn test`
5. 本机 `corepack yarn dist:mac-smoke:huaanwork`；仅当该检出的 provisioning 守卫仍有缺项时，允许使用 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1 corepack yarn dist:mac-smoke:huaanwork`
6. 阶段 B SHA 上的完整分支 CI

另增加结构验收：

- 三个参考桌面目录不存在；
- 根 workspaces 不含三个包名；
- 活跃脚本、测试和 CI 不依赖已删除目录；
- `dsh-community-market` 的 peer range 与已裁定政策一致，不再从已删除通道推导；
- 允许的历史兼容字符串不被误报为另一个桌面实现；
- `desktop-upstream.json` 的基线和 dashboard 报告可由本地 ref 复现。

## 8. 失败处理与回滚

- market 或 AA 的在线新鲜度检查失败时按现有规则停止，不静默保留旧制品冒充成功。
- 阶段 A 失败时不开始删除；阶段 B 失败时不宣告最终单套完成。
- 阶段 A 的全绿 SHA 和 CI run 是独立恢复点。
- 已推送的阶段 B 如需要回退，使用后续修复或 revert，不 force-push。
- 不直接推 master，不自动创建合并结果，不触发发布。
- 现有未跟踪文件不属于本项改动，除非用户另行明确授权，不加入任何提交。

## 9. 非目标

- 不新增或修改 HuaAnWork 产品功能、界面和交互。
- 不做根仓库或产品的额外品牌重命名。
- 不把 unsigned smoke 写成签名、公证或真实多机验收。
- 不顺带处理既有技术债，除非它直接阻断单桌面改造。
- 不改写历史设计、评审和证据文档中的当时事实。
- 不为追求旧包名零命中而删除迁移和兼容逻辑。

## 10. 主要改造面

| 区域 | 阶段 A | 阶段 B |
| --- | --- | --- |
| 根 `package.json`、`yarn.lock` | 单活跃 workspace、命令和依赖重解 | 删除后的最终依赖闭包 |
| `.github/workflows/ci.yml` | 只保留 HuaAnWork 和共享检查 | 复核无残留矩阵或步骤 |
| `upstream.json` | `activeChannel: huaanwork` | 只保留活跃通道 |
| `desktop-upstream.json` | 不引入 | 新增选择性移植审阅基线 |
| market、AA、runtime 脚本 | 改为 HuaAnWork 单活跃输入 | 先落实 market peer range 政策，再清理旧通道与无消费方资产生成规则 |
| variant、icons、layout、README 等根工具 | 退役多桌面活跃职责，保留 HuaAnWork 自有链 | 删除剩余参考专用实现 |
| `dsh-plugin-huaanwork/tests/` | 改单产品拓扑和行为断言 | 增加目录与依赖消失的结构断言 |
| 三个参考桌面目录 | tracked 内容不变 | 删除 |
| `docs/upstream-sync.md`、Agent 规则 | 记录过渡态和单活跃规则 | 记录选择性移植与最终拓扑 |

## 11. 完成定义

只有同时满足以下条件，整个工作才算完成：

1. 阶段 A 的本地与 CI 证据在阶段 B 开始前已经落盘并通过。
2. 最终只有 `dsh-plugin-huaanwork/` 一个自有、可编辑的桌面源码树，只读上游子模组不计入自有实现数量。
3. 最终根命令、CI、测试、market、AA 和 runtime 链只维护 HuaAnWork 桌面。
4. 最终本地完整检查、macOS smoke 和分支完整 CI 全部通过。
5. 上游选择性移植基线、dashboard 和处置纪律可执行，不再依赖整仓合并三个已删除目录。
6. 未直接推 master、未自动合并、未发布，未把验证证据夸大为签名或真实多机验收。
