# 《HuaAnWork 单桌面、单代码维护实施计划》评审（复核稿）

- **评审对象**：`docs/superpowers/plans/2026-10-29-single-desktop-maintenance.md`
- **对照设计**：`docs/superpowers/specs/2026-10-26-single-desktop-maintenance-design.md`
- **设计评审**：`docs/superpowers/specs/2026-10-29-single-desktop-maintenance-design-review.md`（已终审通过）
- **评审日期**：2026-10-29
- **评审基线**：`b5ef3e84a7951941480b50a8749fe6714b8c9fc7`（master HEAD）
- **评审方式**：只读评审；逐条在仓库上复核命令、文件、行号和门禁行为；未修改任何产品文件，未 push，未 dispatch CI。
- **评审结论**：**有条件不通过**——计划的两阶段框架、基线/上游货架、workspace 收窄、CI 矩阵、market/AA/runtime 方向均成立；但有 3 个会让计划在自己的门禁上直接失败的 P0、2 个与设计边界或证据准确性不一致的 P1、2 个 P2 建议和若干 P3 精度/流程备注。修订后可从 Task 1 开工，**不需要修改设计或 DoD**。

> 本文件是复核后的最终意见。上一轮口头评审中的 3 处误报已在 §五 明确撤回，lock 计数已按计划自己的脚本口径修正。

> **2026-10-29 第二轮复评已追加（§九）**：修订版计划已吸收本文件 §一–§四 全部发现（逐项核实见 §九.1）；但新阻断 **B-1/B-2**（§九.3/§九.4）修完才可开工。本文档因追加 §九 而 SHA-256 变化，计划 `:13` 对本文件的钉扎需随下次计划修订重钉。

---

## 一、结论摘要

| ID | 级别 | 复核结果 | 位置 | 概要 |
| --- | --- | --- | --- | --- |
| P0-1 | 阻断 | 确认 | 计划 Task 8/15 | `gh` 默认解析到 upstream，CI dispatch/查询会打错仓库 |
| P0-2 | 阻断 | 确认 | 计划 Task 14/15 | `git rm -r` 不删被忽略的 `node_modules/`、`lib/`、`.DS_Store`，目录消失断言必失败 |
| P0-3 | 阻断 | 确认 | 计划 Task 7/14 | 改根 README 未纳入 `README.i18n.yaml`，`check:bilingual-docs` 必红 |
| P1-1 | 高 | 确认 | 活文档 | `CONTRIBUTING` 仍有阶段 A 后失效的命令；architecture/docs/plugin-development 等活文档仍指向将删除的 `dsh-plugin-desktop/` |
| P1-2 | 高 | 确认 | 计划 Task 9 | “实测基线”漏掉 `0.2.0-rc.2` 与 alpha.1 的 resolutions，证据结论会失真 |
| P2-1 | 中 | 确认（降级） | 计划 Task 5/14 | `active-topology.test.mjs` 未接入任何持续门禁，仅手动执行 |
| P2-2 | 中 | 确认（需明确） | 计划 Task 12 | `docs/upstream-sync.md` §6 的永久 override 清单未明确退役 |
| P3-1 | 低 | 确认 | 计划 Task 1 | Beta 图标读取在 `package.spec.ts:1261`，不在计划列出的行范围内 |
| P3-2 | 低 | 确认 | 计划 Task 3 | `prepare-agents-anywhere-release.mjs:257` 不存在第二处 “all Desktop channels” |
| P3-3 | 低 | 备注（非确认缺陷） | 计划 Task 1/4 | `activeChannel` 与 `verify-layout` 的时序存在潜在歧义 |
| P3-4 | 低 | 备注（流程） | 计划 Task 1/8 | 评审文档作为真相源但未纳入提交；Task 6 会混入既有 CI 注释修订 |

---

## 二、P0：开工前必须修订

### P0-1 `gh` 默认操作 upstream，Task 8/15 的 CI 门禁无法完成

**事实（实测）**

- `gh repo view --json nameWithOwner -q .nameWithOwner` 返回 `anywhere-labs/dsh-desktop`。
- `gh repo set-default --view` 返回“没有默认远端仓库”；`GH_REPO` 环境变量为空；`git config` 中没有 `gh-resolved`。
- 本地 `origin` 是 `kawaiininja/HuaAnWork-Desktop`，`upstream` 是 `anywhere-labs/dsh-desktop`。
- 计划把分支推到 `origin`（计划 `:701`、`:1694`），但 Task 8 Step 4 的 `gh workflow run ci.yml --ref "$BRANCH"`、`gh run list --workflow ci.yml --branch "$BRANCH"`、`gh run watch`、`gh run view`（`:709/:712/:717/:718`）以及 Task 15 的同组命令（`:1695/:1698/:1703/:1704`）都没有 `--repo`。

**影响**

`gh` 会到 upstream 仓库查找 `ci.yml` 和该分支；分支不存在于 upstream，`RUN_ID` 保持为空，Task 8/15 的“同一 SHA 的完整 CI 成功”门禁无法完成。这是设计 §6/§11 的前置硬门槛。

**修订**

在每条 `gh` 命令上显式加 `--repo kawaiininja/HuaAnWork-Desktop`；或开工时执行一次 `gh repo set-default kawaiininja/HuaAnWork-Desktop` 并把该动作写进证据。建议用显式 `--repo`，避免开发者本地配置差异。

**复核**

确认，非误报。`gh` 的解析结果与仓库 remote 配置直接实测，未依赖文档推断。

---

### P0-2 `git rm -r` 不会物理删除参考目录，Phase B 结构验收必失败

**事实（实测）**

三个参考目录当前都有被忽略的残留：

```text
dsh-plugin-desktop:      .DS_Store, lib/, node_modules/
dsh-plugin-desktop-beta: .DS_Store, lib/, node_modules/
dsh-desktop-next:        .DS_Store, lib/, node_modules/
```

`git status --porcelain --ignored` 对每个目录都返回 3 条 `!!` 记录。`git rm -r` 只删除 tracked 文件；我在临时 Git 仓库中复现了同一形态：`git rm -r pkg` 之后 `pkg/` 仍然存在，残留 `.DS_Store`、`node_modules/`、`lib/`。

计划 Task 14 Step 2（`:1577`）使用 `git rm -r`，但：

- Task 14 Step 1 新增的 `expect(existsSync(new URL(directory, workspaceRoot)), directory).toBe(false)`（`:1537`）会失败；
- Task 14 Step 4 的 `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts` 会先失败；
- Task 15 Step 1 的 `corepack yarn test` 会失败；
- Task 15 Step 3 的 `test ! -e dsh-plugin-desktop`（`:1659`）会失败。

`corepack yarn install --immutable` 不会删除 `lib/` 和 `.DS_Store`，不能依赖它兜底。

**修订**

`git rm -r` 后显式清理：

```bash
for d in dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next; do
  test -z "$(git ls-files -- "$d")"
  rm -rf "$d"
done
```

或使用 `git clean -fdx -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next`。建议保留“先验证 `git ls-files` 为空，再删目录”的顺序，避免误删未预期文件。若设计不要求物理目录消失，也可把断言改为 `git ls-files -- <dir>` 为空；但设计写的是“物理单套”，建议前者。

**复核**

确认。临时仓库模拟与当前工作树 `--ignored` 实测均一致；不是对 Git 行为的猜测。

---

### P0-3 改根 README 未纳入 `README.i18n.yaml`，双语门禁必红

**事实（实测）**

`README.i18n.yaml` 记录 root README 的 Git blob hash：

```text
README.md: 1834426007c2c984a43932da650ddca8c4e085f9
README.en.md: e452c8f83fb869d241b18f31f72e8c2f44404273
```

`scripts/bilingual-docs.mjs` 通过 `git ls-files '*.i18n.yaml'` 找到所有记录，并用 `git hash-object --path=...` 对工作树内容重新计算；当前干净树通过（55 records / 110 documents）。只要修改任一 README，记录即过期。

计划 Task 7 修改 `README.md` / `README.en.md`（`:585-586`），Task 14 再次修改（`:1514-1515`）；两次任务的 Files 和 `git add`（`:650`、`:1610`）都没有 `README.i18n.yaml`。因此：

- Task 7 Step 3 的 `corepack yarn check:bilingual-docs`（`:638`）必红；
- Task 14 Step 4 的同名检查（`:1595`）必红；
- 即使实现者临时补了 hash，没有 stage 也会被 Task 8/15 的 `git status --porcelain` 检查拦住。

**修订**

- 把 `README.i18n.yaml` 加入 Task 7、Task 14 的 Files 和 `git add`；
- 每次改完 README 后，用与守卫相同的形态更新两条记录，例如：
  ```bash
  git hash-object --path=README.md -- README.md
  git hash-object --path=README.en.md -- README.en.md
  ```
- 如果按 P1-1 同时修改 `docs/plugin-development.md` 或 `dsh-community-market/README.md`，还要同步更新 `docs/plugin-development.i18n.yaml`、`dsh-community-market/README.i18n.yaml`。

**复核**

确认。计划全文检索 `i18n` 无命中；当前 hash 与记录逐字符一致，说明这不是“已经隐含处理”的误报。

---

## 三、P1：设计一致性 / 证据准确性

### P1-1 活文档清理范围不足

**事实（实测）**

Task 7 的 Files 只有 `AGENTS.md`、`README.md`、`README.en.md`、`docs/upstream-sync.md`；Task 14 只收口 root README 和 AGENTS。但以下都是**活文档**，不是 `docs/superpowers/specs|plans|evidence` 中的历史记录：

| 文件:行 | 当前内容 | 失效时点 |
| --- | --- | --- |
| `CONTRIBUTING.md:49`、`CONTRIBUTING.en.md:45` | `yarn workspace dsh-plugin-desktop verify:notices`，并提交 `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md` | Phase A（Task 1 移除该 workspace 后命令即失败） |
| `CONTRIBUTING.md:38`、`CONTRIBUTING.en.md:38` | “桌面代码位于 `dsh-plugin-desktop/`”“三个自有 package 共用外层 Yarn workspace” | Phase A |
| `docs/architecture.md:56`、`docs/architecture.en.md:56` | 稳定包公开 contract 是 `dsh-plugin-desktop/profile-service` / `pnpm` | Phase B（本地 stable 包删除） |
| `docs/architecture.md:62`、`docs/architecture.en.md:62` | Stable/Beta 源码位于 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/` | Phase A |
| `docs/architecture.md:66`、`docs/architecture.en.md:66` | Stable/Beta 是两个实体 npm 包；`upstream.json` 同时记录两个通道 | Phase B |
| `docs/architecture.md:68`、`docs/architecture.en.md:68` | `X-DSH-Desktop-Channel: stable|beta` 的更新协议 | Phase B |
| `docs/architecture.md:74-75`、`docs/architecture.en.md:74-75` | 链接到 `../dsh-plugin-desktop/docs/plugin-services.md`、`../dsh-plugin-desktop/README.md` | Phase B（链接断） |
| `docs/README.md:33-34`、`docs/README.en.md:33-34` | 链接到 `../dsh-plugin-desktop/...` | Phase B（链接断） |
| `docs/README.md:44`、`docs/README.en.md:44` | 说 `dsh-plugin-desktop/README.md`、`README.zh.md`、`docs/` 是包级参考 | Phase B（文件不存在） |
| `docs/plugin-development.md:16`、`docs/plugin-development.en.md:16` | 链接到 `../dsh-plugin-desktop/docs/plugin-services.md` | Phase B（链接断） |
| `docs/plugin-development.md:25-26`、`:99-101`、`.en.md` 同 | import 示例 `dsh-plugin-desktop/profile-service`、`dsh-plugin-desktop/pnpm` | Phase B（应改指 HuaAnWork 或明确上游 stable 包） |
| `docs/plugin-development.md:200`、`docs/plugin-development.en.md:200` | 链接到 `../dsh-plugin-desktop/docs/plugin-services.md` | Phase B（链接断） |
| `docs/why-desktop.md:48-49`、`docs/why-desktop.en.md:48-49` | 链接到 `../dsh-plugin-desktop/docs/plugin-services.md`、`../dsh-plugin-desktop/README.md` | Phase B（链接断） |
| `dsh-community-market/README.md:64`、`dsh-community-market/README.zh.md:64` | 链接到 `../dsh-plugin-desktop/docs/plugin-services[.zh].md` | Phase B（链接断） |

设计 §5.3 要求“根说明和 Agent 规则改成单一活跃桌面”，并明确“不得以‘历史文档保留’为由留下指向已退役命令的活规则”；§9 只允许保留“历史设计、评审和证据文档中的当时事实”。上表不是历史快照，且 `CONTRIBUTING.md:49` 是阶段 A 就会失效的命令，属于设计明确禁止的“活规则指向已退役命令”。

**修订**

- 在 Task 7 增加“活文档三分类”（改指向 / 保留历史事实 / 删除），至少覆盖上表；
- `CONTRIBUTING.md` / `.en.md` 的 `verify:notices` 改为 `yarn workspace dsh-plugin-huaanwork verify:notices`，`THIRD_PARTY_NOTICES.md` 改指 `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md`（已核对 HuaAnWork 确实有该脚本和文件）；
- architecture / docs index / plugin-development / why-desktop / market README 的链接改指 `dsh-plugin-huaanwork/docs/plugin-services[.zh].md`、`dsh-plugin-huaanwork/README[.zh].md`；HuaAnWork 的 `exports` 确实包含 `./profile-service` 与 `./pnpm`（已核对 `dsh-plugin-huaanwork/package.json`），import 示例可直接替换；
- Task 14 增加一次仅扫活文档的收口，例如：
  ```bash
  ! rg -n 'dsh-plugin-desktop/' CONTRIBUTING.md CONTRIBUTING.en.md \
    docs/architecture.md docs/architecture.en.md docs/README.md docs/README.en.md \
    docs/plugin-development.md docs/plugin-development.en.md \
    docs/why-desktop.md docs/why-desktop.en.md \
    dsh-community-market/README.md dsh-community-market/README.zh.md
  ```
  若保留“上游 stable 包”的说明，应写成 npm 包名而不是本地路径，并显式标注历史/对照性质。

**复核与校准**

确认。它**不是**当前门禁会红的项（除非同时改 `docs/plugin-development.md` 触发其 i18n 记录），所以没有升为 P0；但设计 §5.3/§9 的活规则要求和 Phase B 后的死链是实质缺口。P1 合理。

---

### P1-2 Task 9 的“实测基线”漏掉 `0.2.0-rc.2` 与 alpha.1 的 resolutions

**事实（实测，按计划 Task 9 自己的 `lockText.split(...)` 口径）**

| lane | root resolutions | lock 引用（split 计数） | patches | 计划基线 |
| --- | ---: | ---: | ---: | --- |
| `0.1.5-rc.2` | 0 | 0 | 12 | 只有 12 个旧 patch（准确） |
| `0.1.7-alpha.2` | 0 | 0 | 18 | 0（准确） |
| `0.1.7-rc.1` | 0 | 0 | 19 | 0（准确） |
| `0.1.7-rc.2` | 0 | 0 | 21 | 0（准确） |
| `0.2.0-rc.1` | 0 | 0 | 21 | 0（准确） |
| `0.2.0-rc.2` | **636** | **900** | 22 | **完全未列** |
| `0.2.1-alpha.1` | **642** | 0 | 21 | 只写“lock 为 0” |
| `0.2.1-rc.1` | 682 | 966 | 22 | 活跃 lane |

注：`grep -c 'vendor/dsh-runtime/<version>/' yarn.lock` 得到的是匹配行数（rc.2 为 600、rc.1 为 644），与计划脚本的 `split` 出现次数不同；两者都表明 rc.2 的 lock 引用非零。计划 Task 9 的实际脚本会打印 900/966 这一组。

计划 `:770` 的原文是：

> “`0.1.5-rc.2` 只有 12 个旧 patch、没有 vendor/resolution/lock 消费；四个旧 lane … 的 resolutions/lock 都为 0；alpha.1 lock 为 0；除 `upstream.json` 外没有活跃代码直接引用旧 vendor lane。”

它**没有列出 `0.2.0-rc.2`**，而 Task 11（`:957-959`）明确要删除 `vendor/dsh-runtime/0.2.0-rc.2/` 及其 patches。按当前基线，rc.2 仍有 636 条 root resolutions 和 900 次 lock 引用；如果 Task 9 证据照抄“无消费方”，结论会失真。

**为什么不构成功能阻断**

Task 10 Step 3 先把 `upstream.json` 收成只有 huaanwork，Step 4 再执行 `sync-vendored-runtime.mjs --write --channel huaanwork`。此时 `otherChannels` 为空，`scripts/sync-vendored-runtime.mjs:155-162` 的过滤会把所有 DSH resolutions 清掉并只加 rc.1；随后 `corepack yarn install` 会重解 lock。因此 rc.2/alpha.1 的 resolutions 会在 Task 11 删除资产前被清掉。问题在**证据准确性**，不是立即断裂。

**修订**

- 在 Task 9 证据中记录三档实际计数（rc.2、alpha.1、rc.1），并明确“rc.2/alpha.1 的 resolutions 由 Task 10 `--write` + `yarn install` 清理，Task 11 才删 vendor/patch”；
- 在 Task 11 Step 3 的验证里加一次 `corepack yarn check:vendored-runtime` 和 `git grep 'vendor/dsh-runtime/0.2.0-rc.2' -- ':!docs' ':!yarn.lock'` 复核，确认没有活跃引用；
- 若用户对 `stableHistorical` 选择 `retain`，要明确“保留 peer 腿 ≠ 保留 Stable vendor runtime”（计划 Task 9 已有这句话，保留并在证据中重复）。

**复核**

确认。计数是实跑 `package.json` + `yarn.lock` + `patches/` 得到的；计划原文确实漏项。

---

## 四、P2 / P3：建议修正

### P2-1 `active-topology.test.mjs` 没有接入持续门禁

**事实**

- `package.json:2044` 定义了 `"test:scripts": "node --test scripts/*.test.mjs"`；
- `check`（`package.json:2050`）和 `check:layout`（`:2049`）都不包含 `test:scripts`；
- CI 只跑 `yarn check`；
- 计划在 Task 5（`:444-474`）创建 `scripts/active-topology.test.mjs`，但只在 Task 5 Step 4 和 Task 14 Step 4 手动执行；Task 15 的最终门禁是 `corepack yarn check` / `typecheck` / `test`，不会执行它。

`package.spec.ts` 的最终结构断言（目录不存在、root scripts 不引用三个包）会被 `test` 覆盖；但“参考工具不得重新进入根 glob”这一条只由 `active-topology.test.mjs` 断言，未进入持续门禁。设计 §5.3 要求“根测试 glob 不得暗中继续执行这些参考工具”，计划通过改名实现了当前状态，但未来回归不会被 `check` 捕获。

**修订**

把 `node --test scripts/active-topology.test.mjs` 加进 `check:layout` 或 `check:architecture`，并同步 `expected-root-gate-scripts.json`、`package.spec.ts` 的 `check:layout` 断言；或把 `test:scripts` 接进 `check`（注意 `test:scripts` 会跑全部根测试，需评估时长）。

**校准**

确认，但降为 P2：计划确实在 Task 14 Step 4 手动运行了它，且 `package.spec.ts` 覆盖了主要拓扑；问题在长期回归防护，不是当前门禁必红。

---

### P2-2 `docs/upstream-sync.md` §6 的永久 override 清单未明确退役

**事实**

- `docs/upstream-sync.md` §6（`:100-115`）列出的永久 override 包括 `scripts/verify-desktop-variants.mjs`、`dsh-plugin-desktop/tests/package.spec.ts`、`dsh-plugin-desktop-beta/tests/package.spec.ts`；这些在 Task 14（`:1519-1524`）删除。
- 旧 dashboard 的 Scope C 会解析 §6（`scripts/upstream-sync-dashboard.mjs:141-149`），新 dashboard 不再解析。
- 计划 Task 12 说“`docs/upstream-sync.md` §§1-7 改为 selective 模型”（`:1024`、`:1318`），但列出的内容（reviewedCommit 语义、remote、as-of、逐提交处置、Harness pin 独立）没有点名 §6 的 override 清单。
- §8 从 `:134` 开始，是历史快照；Task 12 的 `1-132` 范围正好停在 §8 之前（这一点上一轮我误以为重叠，复核后撤回）。

**修订**

在 Task 12 明确要求：重写/删除 §6 的永久 override 清单；保留 `expected-root-gate-scripts.json`、`market-manifest-byte-budget.json` 等仍有消费方的条目（如果新模型仍需要），并加一条活文档收口：`rg 'verify-desktop-variants\.mjs' docs/upstream-sync.md` 只允许出现在 §8 历史快照中。

**校准**

确认，但降为 P2：“§§1-7 改为 selective 模型”可被理解为包含 §6；风险是实现者保留旧清单，留下指向已删除文件的活文档。建议明确写死，而不是依赖“§§1-7”这个宽泛范围。

---

### P3-1 Beta 图标读取不在 Task 1 列出的行范围内

Task 1 `:73` 写 `dsh-plugin-huaanwork/tests/package.spec.ts:77-178,1097-1131`，但 Beta 图标读取在 `:1261`（测试名 `ships HuaAnWork-branded icons rather than the upstream artwork`，读取在 `:1263`）。计划正文说“删除 Stable manifest 和 Beta 图标读取；图标使用当前 HuaAnWork 资产哈希”，意图明确，但行范围遗漏了 1261 这段。建议在 Task 1 Files 中补 `:1261-1266` 或直接点名该测试，避免实现者只按行范围改动。

### P3-2 `prepare-agents-anywhere-release.mjs:257` 不存在第二处 “all Desktop channels”

Task 3 `:298` 写 `scripts/prepare-agents-anywhere-release.mjs:160,257`。实际只有 `:160` 一处 `AA release verified: all Desktop channels use ...`；另一个需要改的标题在 `scripts/agents-anywhere-release-policy.test.mjs:47`（`accepts the latest AA across Stable, Beta and Next runtime peers`）和 `:71`（`... keeping both Desktop runtime peer ranges`）。计划 Step 1 已经提到测试标题，建议把 Files 行号改成实际位置。

### P3-3 `activeChannel` 与 `verify-layout` 的时序备注（潜在歧义，非确认缺陷）

Task 1 收窄 `verify-layout`，但 `upstream.json.activeChannel` 到 Task 4 才改成 `huaanwork`。`scripts/verify-layout.mjs:28` 当前接受 `['stable','beta','huaanwork']`；如果实现者在 Task 1 把这一行也收窄成只接受 `huaanwork`（从“单活跃桌面”的语义看很自然），Task 1 Step 5 的 `node scripts/verify-layout.mjs` 会因 activeChannel 仍是 beta 而失败。计划没有明确这一行是否改、何时改。建议写死“activeChannel 在 Task 4 前保持 beta，Task 4 再切换”，或把 `upstream.json` 的 activeChannel 改动并入 Task 1。

**校准**：这是条件性歧义，不是已确认的必然失败；上一轮把它列为“错误”偏重，复核后降为 P3 备注。

### P3-4 提交/真相源备注（流程，非实现缺陷）

- 计划 `:13` 把 `docs/superpowers/specs/2026-10-29-single-desktop-maintenance-design-review.md` 当作真相源，但 Global Constraints `:24` 规定不提交未跟踪评审文档，Task 8 的 status 检查也允许它保持 untracked。建议明确：要么随 Task 1 提交该评审文档，要么把关键结论摘要/哈希写进计划或证据，避免分支上的真相源只存在于本地未跟踪文件。
- Task 6 会保留并提交工作区已有的 CI provisioning 注释修订（`:560`、`:576-577`）；建议在提交说明中注明，或先单独提交该注释修订，避免审查时把注释变更误读为 CI 收窄的一部分。

---

## 五、复核处置与误报撤回

本轮对上一轮意见逐条反证，结果如下：

| 上一轮意见 | 复核结果 | 处置 |
| --- | --- | --- |
| `gh` 默认仓库错误 | 实测 `gh repo view` → `anywhere-labs/dsh-desktop`；无 default、无 `GH_REPO`、无 `gh-resolved` | **确认**，保留 P0 |
| `git rm -r` 目录残留 | 当前工作树 3 个目录各有 3 条 ignored 残留；临时仓库复现 `git rm -r` 后目录仍在 | **确认**，保留 P0 |
| `README.i18n.yaml` 遗漏 | 计划全文无 `i18n`；当前 hash 与记录一致；守卫会校验所有 tracked `*.i18n.yaml` | **确认**，保留 P0 |
| 活文档清理不足 | `CONTRIBUTING.md:49` 命令在 Phase A 后失效；architecture/docs/plugin-development/why-desktop/market README 的链接在 Phase B 后断 | **确认**，保留 P1 |
| Task 9 基线漏 rc.2/alpha.1 | 实测 rc.2 636 resolutions / 900 lock 引用、alpha.1 642 resolutions；计划原文只写 alpha.1 lock 为 0 | **确认**，保留 P1；lock 计数从上一轮的 `grep -c` 行数（600/644）校正为计划脚本的 split 口径（900/966） |
| `active-topology` 未接门禁 | `test:scripts` 仅定义在 `package.json:2044`，`check`/`check:layout`/CI 均不执行 | **确认**，但降为 P2（Task 14 手动执行 + package.spec 覆盖主要拓扑） |
| `docs/upstream-sync.md` §6 未退役 | §6 仍列已删除文件；Task 12 的宽泛“§§1-7”未点名 §6；§8 从 134 行开始 | **确认**，但降为 P2（可被宽泛改写覆盖，需明确） |
| Beta 图标行号遗漏 | 测试在 `package.spec.ts:1261`，读取在 1263；计划范围 77-178/1097-1131 不含 | **确认**，P3 |
| `prepare-agents...:257` | 实际只有 `:160` 一处 “all Desktop channels”；另一标题在 policy test `:47`/`:71` | **确认**，P3 |
| README 行范围 75-180 漏 macOS 段 | 复核：`README.md` macOS 段在 `:175`、`README.en.md` 在 `:175`，都在 75-180 内 | **撤回（误报）** |
| `docs/upstream-sync.md:1-132` 与 §8 重叠 | 复核：§8 从 `:134` 开始，1-132 正好停在 §8 前 | **撤回（误报）** |
| `prepare-dsh-market.test.mjs:73-78` 行号偏 | 复核：entrypoint 测试确实从 `:73` 开始，计划行号准确 | **撤回（误报）** |
| `readdirSync` 顺序不稳定 | 复核：Task 11 删除后 `vendor/dsh-runtime` 只剩一个 lane，单项数组无顺序问题 | **撤回（不构成问题）** |
| `activeChannel` 时序 | 计划未要求收窄 `verify-layout.mjs:28`；若实现者自行收窄才会失败 | **降级为 P3 备注（条件性歧义）** |

---

## 六、已核对为正确的基线事实

以下不是“计划声称”，而是本轮实际复核通过的事实，用于校准评审不是只挑错：

- 基线 `b5ef3e84a7951941480b50a8749fe6714b8c9fc7` 与 master HEAD 一致；`git ls-tree HEAD deepseek-harness` 的 pin 为 `1600d8a1e140dcde43a1a0941940a0480712c011`，与计划一致。
- `44084bdae0d44cac56948a223048d9c31541d0d0..092e2ecef750d10db43cedbab8e81fd48c8de38e` 确实 56 个提交；计划 Task 12 的 reviewedCommit 计算脚本在 HEAD 上得到 `44084bda...`；本地 `upstream/master` 正是 `092e2ece...`；Task 13 的 RULINGS 56 个 SHA 与 `git rev-list` 精确集合相等（15 个 FILE_OVERRIDES 另计，合计 71 行键，不是 71 个提交）。
- 根 workspaces 当前 16 项，Task 1 的 13 项是精确移除三个桌面后的结果；`build`/`typecheck`/`test`/`check`/`check:layout` 的 fixture 字符串与当前脚本逐字一致（除计划要删除的项）。
- `fixtureVersion: 2`、`dshmarket 1.70.2`、`resolutions['dshmarket@npm:1.70.2']`、HuaAnWork `build/app-icon.png` 的 sha256 `532052...` 均与计划一致；`createHash` 已在 `package.spec.ts` 顶部导入。
- `upstream.json` 的 stable/beta/huaanwork 三通道和 `sourceVersion`（0.2.0-rc.2 / 0.2.1-rc.1 / 0.2.1-rc.1）与计划一致；`marketPeerRange` 现值确为 `0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1`；`dsh-community-market` 的 DSH peers 全部是该三腿，`schemastery` 是 `^3.18.4 || ^3.18.5-alpha.1`，不属 DSH 过滤范围。
- `sync-vendored-runtime.mjs` 的 `--write` 在 `upstream.json` 只剩 huaanwork 后会清掉其它通道的 DSH resolutions（`:155-162`）；`checkVendor` 会校验 active lane 的 vendor tarball/resolutions/plugin 引用。
- `vendor/dsh-runtime/` 确有 7 个 lane；旧 lane 的 patches 数与计划 Task 9 的 12 个 `0.1.5-rc.2` patch 一致；vendor lane 中没有被忽略的 `.DS_Store`/`node_modules` 残留（与参考目录不同）。
- CI 的 `changes` 在 `workflow_dispatch` 下强制 `product=true`；AA-skip 循环当前含三包；Windows/macOS 矩阵当前含三包；Linux job 当前只含 stable/beta；Next 的 Playwright/verify 步骤和 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'` 在 `ci.yml` 中的位置与计划断言一致；`splitWorkflowJobs` 助手已存在。
- `verify-layout.mjs` 当前读取 stable/beta/next 清单、`nextReference`、legacy pnpm 清单、7 个 owner 的依赖边界、三通道 runtime 循环和 Next 私有包检查；Task 1 的收窄清单与这些读取点一一对应。
- Stable 的 `desktop-market.ts` 确实把 `community-market` 作为 provider（`packageName: 'dsh-community-market'`），`desktop-plugins.ts` 也列出该包；Task 9 推荐 `stableHistorical: retain` 的证据成立。
- `dsh-plugin-huaanwork/package.json` 的 exports 确有 `./profile-service` 与 `./pnpm`；`docs/plugin-services.md`、`README.md`、`README.zh.md` 均存在，可作为活文档改指向的目标。
- 干净树当前 `node scripts/verify-bilingual-docs.mjs` 输出 55 records / 110 documents consistent；`node scripts/check-whitespace.mjs` 通过。

---

## 七、建议修订顺序

1. **开工前**：修 P0-1（gh `--repo`）、P0-2（目录残留清理）、P0-3（`README.i18n.yaml`）。
2. **Task 1 前**：修 P1-1 的活文档清单、P1-2 的 Task 9 基线口径；把 P3-1/P3-2 的行号一并订正。
3. **Task 12 前**：明确 P2-2 的 §6 处置。
4. **Task 5/14 前**：决定 P2-1 是否把 `active-topology` 接入 `check`。
5. **提交时**：按 P3-4 处理评审文档和 CI 注释修订的提交口径。
6. 修订后从 Task 1 重跑计划自己的门禁；不需要改设计的两阶段、DoD 或证据口径。

---

## 八、复核边界

- 本评审**只读**：未修改任何产品文件、未 commit、未 push、未 dispatch CI；唯一新增文件是本文档。
- `gh` 结论来自 `gh repo view` / `gh repo set-default --view` 和 remote 配置；未实际执行 `gh workflow run`（避免对上游产生副作用）。
- `git rm -r` 结论来自当前工作树的 `git status --ignored` 加临时仓库模拟；未在真实仓库执行删除。
- lock/resolutions 计数来自当前 `package.json`、`yarn.lock`、`patches/` 的本地扫描；`grep -c` 行数与计划脚本的 split 口径有差异，本文以计划脚本口径为准，并注明了差异。
- CI 结构结论来自 `ci.yml` 文本；未运行真实 CI。
- 设计评审文档（`2026-10-29-single-desktop-maintenance-design-review.md`）仍是未跟踪文件；本文引用它作为上游评审背景，不改变其状态。

---

## 九、第二轮复评（2026-10-29：修订版计划再评审）

- **评审对象**：计划修订版（含「评审修订记录（2026-10-29）」节；基线仍为 `b5ef3e84a7951941480b50a8749fe6714b8c9fc7`，实测等于当前 master HEAD）。
- **评审方式**：只读评审 + 逐项实测；除本文档追加本节外未修改任何文件（与 §八 同边界）。
- **评审结论**：**上一轮 P0-1…P3-4 已全部修复（逐项核实见 9.1）；但发现 2 个新阻断 B-1/B-2，按字面执行仍会在计划自己的门禁上失败。修完 B-1/B-2 即达实施标准，可从 Task 1 开工；两处均为纯文本订正，不动设计、DoD 与任务结构。**

> 背景说明：首轮口头评审曾提出 F-P1（ls-tree 断言）/F-P2（“两处 all Desktop channels”）/F-P3（CONTRIBUTING 漏清点）三项。F-P2/F-P3 与本文件 P3-2/P1-1 重合并已随本轮修订修复；**F-P1 未进入本文件前八节，故未被修订吸收**，即 9.3 的 B-1。

### 9.1 上一轮发现逐项核实（全部已修）

| ID | 结果 | 修订版证据（行号为当前计划文件实测） |
| --- | --- | --- |
| P0-1 | 已修 | Task 8 Step 4（`:757-766`）与 Task 15 Step 4（`:1773-1782`）所有 `gh` 命令均显式 `--repo kawaiininja/HuaAnWork-Desktop` |
| P0-2 | 已修 | Task 14 Step 2（`:1640-1650`）：先 `--ignored` 登记残留，`git rm -r` 后 `git ls-files` 双空验证再 `rm -rf` 并 `test ! -e` |
| P0-3 | 已修 | Task 7 Files 含 `README.i18n.yaml`（`:595`）、`git hash-object` 六条（`:671-676`）、commit 暂存三份 `.i18n.yaml`（`:698`）；Task 14 `:1663` 收口 |
| P1-1 | 已修 | 活文档三分类表（`:658-666`）+ `verify:notices` 改 huaanwork（`:662`）+ Task 14 `:1662` 复核扫描与改指向规则 |
| P1-2 | 已修 | Task 9 八 lane 实数表（`:818-831`，含 rc.2 636 resolutions/900 lock 引用、alpha.1 642 resolutions）与“不得把 rc.2 无消费方写进证据”禁令（`:831`）；grep 模式补 `0.2.0-rc.2`（`:815`） |
| P2-1 | 已修 | `test:architecture-gates` 接入 `active-topology.test.mjs` 并挂进 `check:architecture`（`:503`） |
| P2-2 | 已修 | §6 永久 override 清单显式退役/重写 + rg 收口断言（`:1379`） |
| P3-1 | 已修 | Task 1 Files 补 `:1261-1266`（`:77`） |
| P3-2 | 已修 | “只有 `:160` 一处”，并指向 policy test `:47`/`:71`（`:336`） |
| P3-3 | 已修 | activeChannel 时序写死：Task 1 保持 beta、Task 4 切换（`:214`） |
| P3-4 | 已修 | 双评审文档 SHA-256 钉扎（`:13`，与落档时两文件实算一致）+ CI 注释提交说明（`:24`、`:584`） |

### 9.2 基线钉扎复测（承 §六 口径）

- `git rev-parse master` = `b5ef3e84a7…`；当前 `fixtureVersion: 2`、根 workspaces 16 项，与计划 Consumes 一致。
- 四条 gate 串（build/typecheck/test/check）程序化比对：现值按语义去掉三个桌面 workspace 段后与计划 fixture **逐字相等**（四项全 MATCH）。
- `.reference.mjs` 生命周期对账闭合：Task 5 改出 4 个（`:495-498`）→ Task 12 改回 1 个（`:1082`，dashboard 测试）→ Task 14 删 3 个（`:1652`）+ Files 的 `scripts/*.reference.mjs` 通配（`:1587`）；与 Task 5 Step 5 的 add 清单对账无缺口。
- 两份评审文档 hash 与计划 `:13` 钉扎一致（`4745292b…` = design-review、`a8e94ce1…` = 本文件**追加本节前**的内容）。

### 9.3 B-1（阻断，未修）：ls-tree pin 断言恒假（= 首轮 F-P1）

**事实（实测）**

- Task 8 Step 3（`:748`）与 Task 15 Step 2（`:1729`）均为：`test "$(git ls-tree "$PHASE_A_SHA" deepseek-harness | cut -d' ' -f3)" = '1600d8a1e140dcde43a1a0941940a0480712c011'`。
- `git ls-tree` 输出为 `<mode> <type> <sha><TAB><path>`，实测 `160000 commit 1600d8a1e14…<TAB>deepseek-harness`；`cut -d' ' -f3` 切出的是 `<sha><TAB>deepseek-harness`（含 tab 与路径后缀），与裸 SHA 比较恒假。
- 在当前 HEAD（子模组 pin 正是 `1600d8a1e14…`）实跑该断言：**FAIL**。pin 值本身无误（§六 已核对裸值），缺陷纯在断言形态。

**影响**：阶段 A 推送门（Task 8 Step 3）与阶段 B pin 门（Task 15 Step 2）按字面必失败；且失败形态（“pin 不匹配”）会误导执行者去重新核对基线，而不是改断言本身。

**修订**（三选一，均实测可用）：管道改 `awk '{print $3}'`；或 `cut -d' ' -f3 | cut -f1` 两段；或整句改 `test "$(git rev-parse "$PHASE_A_SHA":deepseek-harness)" = '…'`。注意**单独 `cut -f1` 不可用**（输出含 mode/type 前缀）。

**复核**：非误报。§六 漏检原因：只核对了裸 pin 值、未执行断言形态。

### 9.4 B-2（阻断，新发现）：净树门禁豁免漏本评审文档

**事实（实测）**

- 净树门禁四处（`:717`、`:746`、`:1707`、`:1728`）的豁免正则只含 `^\?\? (\.gstack/|docs/superpowers/specs/2026-10-29-single-desktop-maintenance-design-review\.md)$`。
- 计划 `:13` 把本文件钉为“本地复核背景”、`:24` 明示不提交开工前已有的未跟踪评审文档 ⇒ **本文件在整条分支上保持未跟踪、必然留在工作树**。
- 用等价 `grep -vE` 在当前工作树实跑该门禁：**GATE-FAIL**，残留行即 `?? docs/superpowers/plans/2026-10-29-single-desktop-maintenance-plan-review.md`。（同次输出中的 ` M .github/workflows/ci.yml`、` M 设计文档`、`?? 计划本身` 分别由 Task 6、Task 1、Task 1 提交，属执行前预期中间态；唯本文件没有任何任务提交它。）

**影响**：Task 8 Step 1/3、Task 15 Step 1/2 四处门禁在全部任务正确执行后仍红。

**修订**：豁免正则补本文件路径，或收宽为一个覆盖两份评审文档的模式（如 `^\?\? docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md$`）。**连带**：本节落档后本文件 SHA-256 已变，计划 `:13` 对本文件的钉扎（`a8e94ce1…`）随之过期——修 B-1/B-2 订正计划时应一并重钉新值（以订正时实算为准）。

**复核**：非误报；` M`/`??` 各行去向已逐条对账（见上）。

### 9.5 非阻断（登记后延，不拦执行）

| 项 | 事实（实测） | 建议 |
| --- | --- | --- |
| `.gitignore` 死条目 | 根 `.gitignore` 有 8 条参考树条目（`dsh-plugin-desktop/dist/`、`dsh-plugin-desktop/lib/`、`dsh-plugin-desktop/.desktop-build/`、`dsh-plugin-desktop-beta/.desktop-build/`、`dsh-desktop-next/lib/`、`dsh-desktop-next/dist/`、`dsh-desktop-next/.desktop-next/`、`dsh-desktop-next/.desktop-build/`），Task 14 删树后成死条目；计划无清理动作 | 不碍任何门禁；并入 Task 7 triage 或 Task 14 顺带清理 |
| `assets/app-icons.source.json` | `artwork.stable/next` 指向将删目录（`dsh-plugin-desktop/build/…`、`dsh-desktop-next/build/…`）；全仓无代码引用该文件名（纯溯源文档） | 并入 Task 7 triage“历史身份”类登记，可不改内容 |
| 净树门禁 rg fail-open | `rg … || true` 在 rg 不在 PATH 时空转通过（本轮复评实撞：`command not found: rg` 被吞、首次测试得假 CLEAN） | 执行机确认 rg 在 PATH；或四处门禁统一改 `grep -vE` |

### 9.6 放行条件

修 **B-1**（`:748`、`:1729` 两处断言）与 **B-2**（`:717`、`:746`、`:1707`、`:1728` 四处正则 + 重钉本文件 hash）后，计划即达实施标准，从 Task 1 开工；9.5 各项登记后延。设计、DoD、两阶段边界与任务结构均不需改动。
