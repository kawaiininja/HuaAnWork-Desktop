# M2 范围裁定（R-M2-2）与最终门槛证据

- **日期**：2026-10-25
- **批准**：用户（M2 整改控制器转达裁定 R-M2-2，2026-10-25；Task 14 交接中明确「keep the four out-of-plan files and record them」）
- **基线**：`c411d12d891de6179e1c72d1afcab5995bbbe0b6`
- **整改代码 HEAD**：`93c1bb029134aa79d26ce3cff3ba2d55e5aa5bf1`（Windows M2 绿跑所在提交）；其后 `32db078253`、`2069df57d3`、`1c968f9e34` 为证据文档提交，不改代码
- **最终 HEAD（本文末门槛表所在提交）**：内容提交无法在自身内部写出自身 SHA；精确值用
  `git log -1 --format=%H -- docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md` 查询
- **关联裁定**：R-M2-2（I-18 范围）、R-T12-1（variant 白名单 64→65）、R-T14-1（AGENTS.md 计数与计划同步）、R-T7-1（验收探针 redaction helper）、R-M2-3（I-20 延后）

## 一、四个计划外文件（保留）

`git diff c411d12d89..1c968f9e34 -- <file>` 均可在本仓库复核；下列摘录是该 diff 的最小片段。

| 文件（登记行号） | 改动 | 理由 | 证据 / 批准 |
|---|---|---|---|
| `dsh-plugin-desktop/tests/package.spec.ts:113` | `EXPECTED_WORKSPACES` 追加 `packages/catalog-signing`、`packages/agent-package-format`、`agent-catalog-server`、`agent-catalog-admin`；`workspaces` 断言 `12 → 16` | M2 在根 `package.json` 注册四个新 workspace；该包测试把根门禁清单钉成精确长度与成员表，不同步则 stable 包测试在正确的新拓扑上失败。只改断言 fixture，不改被测产品代码 | `git diff c411d12d89..1c968f9e34 -- dsh-plugin-desktop/tests/package.spec.ts`；批准 R-M2-2 / 2026-10-25 |
| `dsh-plugin-desktop-beta/tests/package.spec.ts:123` | 同上（beta 侧同一 fixture，两文件逐字节同形） | 同上；两个 Desktop 变体各自持有该测试，漏改任一侧都会让一侧变红 | `git diff c411d12d89..1c968f9e34 -- dsh-plugin-desktop-beta/tests/package.spec.ts`；批准 R-M2-2 / 2026-10-25 |
| `market-server/Dockerfile:5` | 头部注释：运行期 workspace 依赖从 1 个改为 2 个，补 `@huaanwork/catalog-signing`（`exports` 指向原始 `src/index.ts`，派生镜像必须携带编译后 JS 副本；或改用仓库工作区挂载） | `market-server/src/signing.ts` 新增对 `@huaanwork/catalog-signing` 的**运行期 value import**（`canonicalJson` / `signCanonical` / `verifyCanonical` / key helper）；镜像只拷 `package.json` + `src`，部署方必须知道闭包多了一项，否则 import 期直接失败 | `git diff c411d12d89..1c968f9e34 -- market-server/Dockerfile`；批准 R-M2-2 / 2026-10-25 |
| `docs/market-server-deployment.md:87` | 部署闭包章节：闭包从「一个 workspace 依赖」改为「两个」；新增 `@huaanwork/catalog-signing` 的解析方式、`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 限制、两条可行形态（仓库工作区挂载 / 编译后 JS 副本）、新增两类失败签名，并诚实登记「新增依赖后的派生镜像未实测」 | 同上；runbook 是部署方唯一操作依据，Dockerfile 注释与 runbook 必须同源，否则运维会按旧闭包启动失败。文档只扩大事实披露，不改变既有部署门 | `git diff c411d12d89..1c968f9e34 -- docs/market-server-deployment.md`；批准 R-M2-2 / 2026-10-25 |

摘录（workspace 门禁，stable 与 beta 同形）：

```diff
+      'packages/catalog-signing',
+      'packages/agent-package-format',
+      'agent-catalog-server',
+      'agent-catalog-admin',
     ]
-    expect(workspaceManifest.workspaces).toHaveLength(12)
+    expect(workspaceManifest.workspaces).toHaveLength(16)
```

摘录（Dockerfile）：

```diff
-# This image ships the server's own code. market-server also imports the
-# `dsh-community-market/contracts` workspace package (which needs `ajv`), so
-# the deployment supplies that closure at /app/node_modules - see the
+# This image ships the server's own code. market-server also imports TWO
+# workspace packages at runtime: `dsh-community-market/contracts` (needs `ajv`
+# and its built lib/), and `@huaanwork/catalog-signing` (exports raw
+# src/index.ts, so a derived image must carry a COMPILED JS copy - Node refuses
+# type stripping under node_modules).
```

**结论**：保留上述四个文件；除此之外，`c411d12d89..HEAD` 的计划外改动为零。M2 计划
`docs/superpowers/plans/2026-10-24-chat-created-agent-packages-m2.md` 的 Global Constraints
与 Modify 表已同步这四文件（R-M2-2），`docs/market-server-deployment.md` 的「新增依赖后的
派生镜像未实测」是**诚实登记的部署门**，不是本轮声称已完成的部署验证。

## 二、变体守卫与白名单（R-T12-1 / R-T7-1）

Task 12（I-4）把 huaanwork 的 bundled 运行时闭包纳入许可证与 notices 图，由此产生三处守卫
记账，均已按裁定落地：

| 项 | 处置 | 名额成本 |
|---|---|---|
| `dsh-plugin-huaanwork/scripts/verify-licenses.mjs` | 两侧都存在但内容确实分叉：huaanwork 多遍历 pushed 进 `lib/` 的 bundled 闭包（`@huaanwork/*`、`tar` 及其依赖），notices 多出 Bundling 列与逐包许可证原文；beta 只遍历安装态 production 图。计入 `beta↔huaanwork allowedDifferences` 第 **65** 项（裁定 R-T12-1） | 1 |
| `dsh-plugin-huaanwork/scripts/bundled-runtime.spec.mjs` → `huaanwork-bundled-runtime.spec.mjs` | 更名落入既有 `scripts/huaanwork-` 单侧前缀（提交 `0b22d95f20`） | 0 |
| `dsh-plugin-huaanwork/scripts/verify-bundled-runtime.mjs` → `huaanwork-verify-bundled-runtime.mjs` | 同上 | 0 |
| `dsh-plugin-huaanwork/scripts/huaanwork-acceptance-redaction.mjs` | Task 7（I-8）的探针 redaction helper，纯函数模块，由探针 import；同属 `scripts/huaanwork-` 前缀，不占额（裁定 R-T7-1） | 0 |

**权威计数现状**：`stable↔beta 7`、`beta↔huaanwork 65`、`oneSidedPrefixes 6`。AGENTS.md 的
权威计数句与 `scripts/verify-desktop-variants.test.mjs` 的计数钉均已同步为 65（R-T14-1）。
M2 计划与整改计划中的 `7/64`、`7/64/6` 引用同步改为 `7/65`、`7/65/6`。

## 三、最终门槛

在本文所在的最终代码 HEAD 上按下列顺序执行（不并行）。命令、退出码与关键输出见
〈附录 A：最终门槛原始记录〉。

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `corepack yarn test` | **0** | 15 个 workspace 全绿；代表性计数：stable/beta `143 passed (143)`、`261 passed \| 4 skipped (265)`、`77 passed (77)`、`14 passed (14)`；node:test 各组 `# fail 0` |
| 2 | `corepack yarn typecheck` | **0** | 11 个 workspace 逐个通过；末行 `contract-types: 4 generated type files are current` |
| 3 | `corepack yarn check:desktop-variants` | **0** | `stable↔beta allowlist 7 (oneSidedPrefixes 0), beta↔huaanwork allowlist 65 (oneSidedPrefixes 6)`；11 个 node:test 全 `ok` |
| 4 | `corepack yarn check` | **0** | 含 `check:whitespace`、`check:layout`、aa connector 与 13 个 workspace `check`；`verify-layout: ... consistent`、`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`、`verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined; tar is compiled into lib` |
| 5 | `node scripts/verify-layout.mjs` | **0** | `verify-layout: all Desktop workspaces including Next and upstream 1600d8a1e1 are consistent` |
| 6a | `cd dsh-plugin-huaanwork && corepack yarn verify:licenses` | **0** | `verify-licenses: 636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)` |
| 6b | `corepack yarn verify:closure` | **0** | `verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.` |
| 6c | `corepack yarn verify:notices` | **0** | 重生成后 `git status --porcelain dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md` 为空 ⇒ **无漂移** |
| 6d | `corepack yarn verify:bundled` | **0** | `verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined; tar is compiled into lib` |
| 7 | `git diff --check c411d12d89..HEAD` | **0** | 无输出 |
| 8 | `git status --porcelain` | — | 空（门槛表提交后复核，见附录 A 末尾） |

门槛第一次尝试时 **gate 4 在 `check:whitespace` 处失败（exit 1）**：
`docs/superpowers/plans/2026-10-25-chat-created-agent-packages-m2-remediation.md:2387: new blank line at EOF`。
修复 = 删除该计划文件末尾多出的 3 个空行（提交 `cd9c715756`），随后从 gate 1 起重跑全部门槛并
全部通过。失败与修复都保留在记录里，不以重跑覆盖。

## 附录 A：最终门槛原始记录

全部门槛在 **`cd9c7157565d81b4d3dc66c3becf1ecc589b6686`**（`docs: trim the remediation plan's
trailing blank line`，工作树干净）上按顺序单独执行；该提交之后只有本证据文档的表格提交，
不改代码、计划或门禁。原始日志保存在执行机的 `/tmp/m2-task14-gates/`（不随仓库分发），
下表是可复核的命令与退出码摘要。

| # | 命令 | 退出码 | 备注 / 关键输出 |
|---|---|---|---|
| 1a | `corepack yarn test` | 0 | 在 `a776fd3b40` 上首跑（该提交仅含证据文档）。 |
| 1b | `corepack yarn test` | **0** | 在 `cd9c715756` 重跑；15 个 workspace 全绿，0 fail。 |
| 2a | `corepack yarn typecheck` | 0 | 在 `a776fd3b40` 上首跑。 |
| 2b | `corepack yarn typecheck` | **0** | 在 `cd9c715756` 重跑；`contract-types: 4 generated type files are current`。 |
| 3a | `corepack yarn check:desktop-variants` | 0 | 在 `a776fd3b40` 上首跑；7/65/6。 |
| 3b | `corepack yarn check:desktop-variants` | **0** | 在 `cd9c715756` 重跑；`stable↔beta allowlist 7 (oneSidedPrefixes 0), beta↔huaanwork allowlist 65 (oneSidedPrefixes 6)`。 |
| 4-0 | `corepack yarn check` | **1** | **首次尝试失败**：`check:whitespace` 报 `docs/superpowers/plans/2026-10-25-chat-created-agent-packages-m2-remediation.md:2387: new blank line at EOF`。未删步骤、未跳步骤；修复见下。 |
| — | `node -e "…replace(/\n+$/,'\n')"` + `git commit` | 0 | 删除该计划文件末尾 3 个空行，提交 `cd9c715756`。 |
| 4 | `corepack yarn check` | **0** | 在 `cd9c715756` 全量通过；含 `check:whitespace`、`check:layout`、`test:aa-connector` 与 13 个 workspace `check`。关键行：`verify-layout: all Desktop workspaces including Next and upstream 1600d8a1e1 are consistent`；`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`；`verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined; tar is compiled into lib`；`verify-licenses: 636 packages checked (9 bundled)`；`verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.` 无 `verify:aa` 并发复现。 |
| 5 | `node scripts/verify-layout.mjs` | **0** | `verify-layout: all Desktop workspaces including Next and upstream 1600d8a1e1 are consistent` |
| 6a | `corepack yarn verify:licenses`（cwd `dsh-plugin-huaanwork`） | **0** | `verify-licenses: 636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)` |
| 6b | `corepack yarn verify:closure` | **0** | `verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.` |
| 6c | `corepack yarn verify:notices` | **0** | 重生成 `THIRD_PARTY_NOTICES.md`；随后 `git status --porcelain dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md` 空 ⇒ 无漂移 |
| 6d | `corepack yarn verify:bundled` | **0** | `verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined; tar is compiled into lib` |
| 7 | `git diff --check c411d12d89..HEAD` | **0** | 在 `cd9c715756` 测得，无输出 |
| 8 | `git status --porcelain` | — | 在 `cd9c715756` 测得，输出为空 |

阅读顺序：1a/2a/3a 是首跑，4 首次失败在 `check:whitespace`；修复提交为纯文档空行删除，
因此 1b/2b/3b 在修复后的同一 HEAD 重跑，4～8 全部在该 HEAD 执行。最终 HEAD（本表所在提交）
上的 `git diff --check` 与 `git status` 复核结果记录在同目录的 Task 14 报告中。
