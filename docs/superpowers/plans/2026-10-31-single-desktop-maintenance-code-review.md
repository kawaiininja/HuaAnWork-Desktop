# HuaAnWork 单桌面维护分支实施评审（复核稿）

- **评审对象**：分支 `refactor/huaanwork-single-desktop-maintenance` 相对 `master` 的实施
- **对照计划**：`docs/superpowers/plans/2026-10-29-single-desktop-maintenance.md`、`docs/superpowers/plans/2026-10-30-single-desktop-followups.md`
- **对照活文档**：`docs/upstream-sync.md` §§1–4
- **评审日期**：2026-10-31
- **评审区间**：`b5ef3e84a7951941480b50a8749fe6714b8c9fc7`（`master`）..`7b2f2cbda87a4e9ce6e9742a1250142c0add58d3`（本地 HEAD，含尚未推送的提交）
- **复核环境**：Git 2.55.0。合并提交、`quotePath`、重命名与子串断言在临时仓库或 `node` 中复现；未改产品文件，未跑 `yarn check`
- **评审结论**：**通过，可以合并。** 没有阻断项。上一轮「With fixes / 两条 Important 合并前应修」不成立：一条是误报，两条真实现象的严重度被抬高。残余都是测试或看板的潜伏缺口，当前 CI、首期货架和已安装的 `dshmarket@1.73.5` 补丁没有因此出错。

> 本文件是对 2026-10-31 口头评审的复核稿。上一轮结论已按本节表格改写；未在表中出现的优点，抽查后仍然成立，见 §三。

---

## 一、上一轮意见的复核

| ID | 上一轮 | 复核 | 位置 | 概要 |
| --- | --- | --- | --- | --- |
| W1 | Important，合并前应修 | **降为残余，不阻断** | `scripts/upstream-sync-dashboard.mjs:77` | 无 `-c` 的 `diff-tree` 会把合并提交自己的冲突解决和新增文件报成零文件。实现与计划、活文档的处方一致；首期 14 个 merge 用 `-c` 看也是空的 |
| W2 | Important，合并前应修 | **降为残余，不阻断** | `dsh-plugin-huaanwork/tests/package.spec.ts:1153` | `toContain('run: yarn check')` 也能匹配 `run: yarn check:layout`。这是后续计划 Task 11 写明的断言；当前 `ci.yml:113` 就是 `run: yarn check` |
| W3 | Minor | **撤回（误报）** | `package.spec.ts:1157`、`:1172` | `workspace: [dsh-plugin-huaanwork, other]` **不**包含子串 `workspace: [dsh-plugin-huaanwork]`，闭合方括号把前缀匹配挡住了 |
| W4 | Minor | **确认，维持低** | `upstream-sync-dashboard.mjs:77` | Git 2.55 上 `core.quotePath=false` 仍会 C-quote 含 `"` 的路径 |
| W5 | Minor | **确认，维持低** | `upstream-sync-dashboard.mjs:66-74` | 以 `/` 结尾但目录不存在的 `watchedPaths` 会静默监视空集。当前配置的 11 个目录在 `reviewedCommit` 都是 `040000` |
| W6 | Minor | **确认是测试缺口，不是行为缺陷** | `upstream-sync-dashboard.test.mjs:86-97` | 缺 `upstream` remote、remote URL 不符这两支没有夹具。代码 `:49` 有检查 |
| W7 | Minor | **确认，维持备注** | `package.spec.ts:112-121` | 带引号的 job 键不会进入 `splitWorkflowJobs`。当前 `ci.yml` 的六个 job 都是无引号键 |
| W8 | Minor | **撤回为当前缺陷** | `upstream-sync-dashboard.mjs:77` | Git 2.55 的 `diff-tree` 未传 `-M` 时列出重命名的旧路径和新路径；`diff.renames=true` 也不折叠。与活文档「不使用重命名检测」一致 |
| W9 | Minor | **确认，且不是这次升级引入的** | `lib/routes.js:2221-2223` 与 `dshmarket-compat.spec.ts:149-208` | `channelFor` 恒含 `dshmarket` 在补丁里；拿掉这一行时，该用例仍会走 `/latest` 并保持绿色 |

没有发现上一轮漏掉的阻断项。抽查范围见 §三；全量 `yarn check` 没有在本次复核中重跑。

---

## 二、逐条

### W1 合并提交的 direct files：现象属实，严重度夸大

**事实（Git 2.55，临时仓库，两个父提交）**

对一次含内容冲突、冲突解决结果与任一父提交都不同、并在合并提交中新增 `docs/evil-only.md` 的 merge：

| 命令 | 输出 |
| --- | --- |
| `git diff-tree --no-commit-id --name-only -r --root HEAD` | 空 |
| 同上加 `-c` 或 `--cc` | `docs/evil-only.md`、`scripts/a.mjs` |
| 同上加 `-m` | 上述两文件，外加干净来自父提交的 `docs/side-only.md` 和 master 上新增的带引号路径 |

干净的 `--no-ff` 空合并上，默认命令和 `-c` 都是空输出。因此给现有命令加上 `-c` 不会把「子提交已经列过的文件」再记到合并容器上，也不会让现有夹具 `upstream-sync-dashboard.test.mjs:81`（merge container 的 files 为空）变红。

**为何不能写成「实现偏离计划」**

维护计划 Task 12 算法第 5 条写的就是 `git diff-tree --no-commit-id --name-only -r --root <sha>`，并写明「merge 不用 `-m`，因此不重复子提交文件」。`docs/upstream-sync.md:82` 把同一条命令收成活规则，并写「merge 容器不重复子提交的文件（通常就是 `(zero direct files)`）」。当前 `upstream-sync-dashboard.mjs:77` 与这两处一致。

**为何也不阻断合并**

`44084bdae0d44cac56948a223048d9c31541d0d0..092e2ecef750d10db43cedbab8e81fd48c8de38e` 中有 14 个 merge。对这 14 个提交跑 `-c`，combined diff 全部为空。首期货架把它们记成零 direct files，没有漏掉冲突解决或 merge-only 文件。本地 `upstream/master` 就停在 `reviewedCommit`，这段范围之后也没有待审 merge。

**影响**

缺口是潜伏的：以后若有合并提交自己改出父提交都没有的内容，看板会打印 `(zero direct files)`，审阅人会把它当成空容器。看板按 `upstream-sync-dashboard.mjs:15-16` 不得接入门禁，所以这不改变产品行为。

**若以后修**

在 `:77` 的 `diff-tree` 上加 `-c`，并加一个夹具：冲突解决路径和 merge-only 路径出现在合并提交上，干净的 side-only 路径不出现。不要改用 `-m`。

### W2 `yarn check` 断言过宽：现象属实，严重度夸大

**事实**

`package.spec.ts:1153`：

```ts
expect(jobs.check).toContain('run: yarn check')
```

`'run: yarn check:layout'.includes('run: yarn check')` 为 `true`。后续计划 Task 11 Step 5（该计划 `:726-730`）写的就是这两行，含 `not.toMatch(/chromium|playwright install/iu)`。实现与计划一致。

当前工作流是对的：`.github/workflows/ci.yml:113` 为 `run: yarn check`。同文件的 job 集合断言（`package.spec.ts:1148-1150`）钉住六个 job 名。把根门禁换成 `yarn check:layout` 时，只有这一条 `toContain` 挡不住。

**影响**

这是计划处方带进来的弱断言，不是当前 CI 写错。不作为合并条件。若收紧，用与 `:1164` 相同的行尾锚，例如 `toMatch(/^ {8}run: yarn check$/m)`。

### W3 矩阵 `toContain`：误报，撤回

**事实**

`'workspace: [dsh-plugin-huaanwork, other]'.includes('workspace: [dsh-plugin-huaanwork]')` 为 `false`。针样子串以 `]` 结束，追加矩阵格后该位置是 `,`。

`ci.yml:127` 与 `:184` 都是 `workspace: [dsh-plugin-huaanwork]`。`package.spec.ts:1157` 和 `:1172` 对这种单行数组是闭合匹配，不是 `dist:win` / `dist:win-portable` 那种前缀洞。上一轮把两类断言当成同一类，不成立。

`dist:win` 的行尾锚（`:1164-1165`）仍然是必要的，那一处没有被撤回。

### W4 含引号的路径仍被 C-quote：确认

**事实（Git 2.55）**

对提交中的 `docs/say "hi".md`：

- `git -c core.quotePath=false diff-tree --no-commit-id --name-only -r <sha>` 的字节是 `"docs/say \"hi\".md"`
- `core.quotePath=true` 的输出相同

`startsWith('docs/')` 对这个字符串为假，该文件会进 `unwatched`。F9 修的是八进制转义（`docs/中文.md`），夹具 `upstream-sync-dashboard.test.mjs:108-114` 覆盖的是这一类，不覆盖 `"`。

当前 `desktop-upstream.json` 的 `watchedPaths` 和已审的首期货架都不依赖含引号的路径。维持低优先级。若修，用 `diff-tree -z` 并按 NUL 分割，且不要对这块输出做会破坏引号的按行解析。

### W5 错误的目录型 `watchedPaths` 静默通过：确认

**事实**

`:66` 只校验**不以** `/` 结尾的条目。`scriptss/` 会跳过 `ls-tree` mode 检查，`:74` 的前缀匹配监视空集，函数仍返回 `ok: true`。

当前 11 个以 `/` 结尾的条目，在 `reviewedCommit` `092e2ecef750d10db43cedbab8e81fd48c8de38e` 上 `git ls-tree` 的 mode 都是 `040000`（`.yarn/`、`.github/`、`scripts/`、`patches/`、`vendor/`、`assets/`、`dsh-community-market/`、`dsh-community-fabric/`、`dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`）。配置本身没有踩中这个洞。

### W6 两支 fail-closed 没有夹具：确认是测试缺口

`upstream-sync-dashboard.test.mjs:86-97` 覆盖了缺失 ref、缺失配置、非祖先 `reviewedCommit`。没有删除 `upstream` remote，也没有把 remote URL 改成与 `desktop-upstream.json` 不符的值。

`:49` 在 `rev-parse` 之前比较 `git remote get-url upstream` 与 `config.repository`，不符则进入 `:53-54` 的 `ok: false`。行为在代码里，缺的是回归钉。不把它写成运行时缺陷。

### W7 带引号的 workflow job 键：确认，保持备注

`splitWorkflowJobs`（`package.spec.ts:116`）只匹配 `^ {2}([A-Za-z0-9_-]+):$`。把一份副本里的 `desktop-windows:` 换成 `"desktop-linux":` 后，解析结果不再包含这个键。

因此，在保留现有六个无引号 job 的同时再追加一个带引号的 job，`:1148` 的集合相等断言仍然通过。当前 `ci.yml` 解析出的就是 `changes`、`check`、`desktop-windows`、`desktop-macos`、`gitleaks`、`upstream-command-windows`，没有引号键。这是断言对对抗性 YAML 的缺口，不是现有工作流多了一个 job。

整份 `ci.yml` 仍有 `not.toMatch(/dsh-plugin-desktop(?:-beta)?/)` 和 `not.toContain('dsh-desktop-next')`（`:1183-1184`）。带引号的 job 若写回这三棵树的名字，这两条仍会红。

### W8 重命名检测：当前不构成缺陷

Git 2.55、`diff.renames` 未设置时，`git diff-tree --no-commit-id --name-only -r` 对 `README.md` → `README-renamed.md` 列出新旧两条。加上 `-M` 只剩新路径。再测 `git -c diff.renames=true diff-tree ...`（不传 `-M`），仍然是新旧两条。

`docs/upstream-sync.md:82` 写的就是这个行为。上一轮「未来 Git 可能在 plumbing 里默认折叠重命名」是推测，本次在 2.55 上没有复现。不记为缺陷。若要钉死，可显式传 `--no-renames` 并加夹具；那是预防，不是纠错。

### W9 `channelFor` 没有被兼容测试单独钉住：确认，且原先就如此

补丁中的行为在安装树 `dsh-plugin-huaanwork/node_modules/dshmarket/lib/routes.js:2219-2223`：

```js
const channel = activeChannel();
const installed = readInstalled(config.profile, activeProfileDir);
const channelFor = new Map([...new Set([...Object.keys(installed), 'dshmarket'])]
    .filter(name => SELF_NAMES.has(name))
    .map(name => [name, channel]));
```

`lib/updates.js:879-882`：`channelFor.get(name)` 为 `undefined` 时，`latest` 直接取 `/latest` 的 `version`，不再调 `versionOnChannel`。`dshmarket-compat.spec.ts:149-208` 把 registry `fetch` 一律 mock 成 `{ version: '9999.0.0' }`，断言的是 `latest: '9999.0.0'` 和 `updateAvailable: true`。拿掉 `Set` 注入后，只要 `hostProvidedNpmVersions` 仍让未声明的 `dshmarket` 进入更新检查，这条用例的断言仍然满足。

这是行为 2 的覆盖缺口，不是 1.73.5 重做补丁时删掉或放宽的用例。七类行为在补丁和安装树里各出现一次，见 §三。

---

## 三、抽查后仍然成立的实施结论

这些不是把上一轮原文再贴一遍，而是本次复核时重新看过的事实。

- 删除提交 `cbd392fbc7` 之前，`git diff b5ef3e84a7951941480b50a8749fe6714b8c9fc7 cbd392fbc7^ -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next` 为空。
- `deepseek-harness` 在区间两端都是 `1600d8a1e140dcde43a1a0941940a0480712c011`。
- `dsh-plugin-huaanwork/src` 在本区间只有 `jobs-bridge.ts`、`settings-bridge.ts` 的注释变化，没有可执行代码变化。
- 根 `package.json` 的 `resolutions` 里只有一条 `dshmarket@npm:1.73.5`，指向 `.yarn/patches/dshmarket-desktop.patch`。插件依赖是 `1.73.5`。
- 已安装的 `dsh-plugin-huaanwork/node_modules/dshmarket/lib/routes.js` 里 `checkUpdates(` 有 3 处，3 处都带 `hostProvidedNpmVersions`。补丁同时包含：`updates["dshmarket"]` 的 self 判据（两处）、`channelFor` 的 `Set` 注入、安装 spec / `readInstalledVersion` / `beforeVersion` 对 `marketVersion()` 的回落、`trialBefore` 与 `introducedErrors`、以及 `lib/updates.js` 里注入 installed、写入 `cacheKey`、缺声明时回落提供的版本。
- `dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs:26-29` 在 `argv.length > 2` 时 `process.exit(2)`。`mkdtempSync` 在 `:72`，位于该判断之后。

---

## 四、结论

分支可以合并。合并提交漏报和 `yarn check` 弱断言都是真的，但前者是计划与活文档写明的命令，且没有让首期货架漏记文件；后者是后续计划写明的断言，且当前 workflow 步骤是根门禁 `yarn check`。矩阵前缀和「当前 Git 会折叠重命名」两条不成立。其余四条维持为低优先级残余，不作为本次合并的条件。
