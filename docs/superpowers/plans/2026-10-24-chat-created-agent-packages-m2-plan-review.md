# 《会话内创建智能体包 M2 实施计划》plan-review 评审意见

- **评审对象**：`docs/superpowers/plans/2026-10-24-chat-created-agent-packages-m2.md`（13 任务；评审时该文件为 untracked）
- **对照规格**：`docs/superpowers/specs/2026-10-23-chat-created-agent-packages-design.md` §8–§12（M2 部分）
- **辅助材料**：M1 实施代码评审 `docs/superpowers/specs/2026-10-24-chat-created-agent-packages-m1-code-review.md`；仓外 M-A0 目录服务（相对仓库根 `../../agent-catalog-server/`）
- **评审日期**：2026-10-24
- **评审基线**：`168637e189adf3720d4afcf86e9f7cfded336784`（计划自述核对基线，与当前 HEAD / `origin/master` 一致；工作树除计划文件本身 untracked 外干净）。本文所有行号均以该基线为准。
- **评审方式**：对照复核——计划的关键可验证断言（基线 commit、62 个 RPC、`signing.ts` 行号与函数名、fixture 版本、market-server 依赖与脚本事实、M-A0 行为、M1 资产函数名/行号、root 门禁 fixture）逐条在基线上机械核验；规格 §8–§12 逐节做任务映射核对；对照 M1 代码评审的债务清单核对衔接。
- **评审结论**：**放行**。无 P1/P2；P3×2（建议实施前顺手修订计划文本）+ 观察×4。按本次评审指令，计划文本与代码均未改动，P3 项留待计划修订或实施首任务时处置。
- **修订记录**：2026-10-24 第二轮复核——修订方（Claude）对计划完成一轮修订（1173→1204 行，计划仍为 untracked，代码未动），P3-1/P3-2 已落盘采纳，并另修复四项第一轮漏检的真实缺陷；复核结论**维持放行**，新增 P3-3，详见 §七。第三轮：P3-3 已按选项①（`installed:false` 未安装判别分支）落盘消解，见 §7.4 处置记录。

---

## 一、事实核查（计划关键断言逐条）

全部核验通过，未发现事实性错误。计划自述的基线、文件/函数/行号、版本号、环境变量名、错误文案均与基线代码一致。

| # | 计划断言 | 核查结果 | 出处（基线行号） |
|---|---|---|---|
| 1 | 基线 `168637e189...`；现有 62 个 RPC，M2 后 69 | ✅ HEAD 一致；注释、期望表与双端计数断言均为 62 | `api.ts:13`、`api.spec.ts:76/143-144`、`route-contract.spec.ts:342-347` |
| 2 | 路由路径风格 `/huaanwork/agent/package/*`、GET+`objectQuery` | ✅ M1 现有 5 条 package 路由同风格 | `dsh-plugin-huaanwork/src/client-huaanwork/api.ts:89-98` |
| 3 | `signing.ts:190-291,417-440` 为可抽取原语；签名对象 `{version,algorithm,keyId,slot,signedAt,signature}` | ✅ `canonicalJson`/`generateKeyPair`/`fingerprintPublicKeyHex`/`extractRawPublicKeyHex`/`publicKeyFromHex`/`signCanonical`/`verifyCanonical` 逐一对上；`signManifest` 与计划 `CatalogSignature` 同构 | `market-server/src/signing.ts` |
| 4 | signing vectors `fixtureVersion:3` 不得重生成 | ✅ 且 fixture 注释「keyId resolution is authoritative, declared slot is metadata」与计划验签语义一致 | `market-server/tests/fixtures/signing-vectors.json:2` |
| 5 | market-server 无 `tar`、build=no-op、`--experimental-strip-types` 启动、vitest 4.1.8、`@types/node ^22.20.0`、TS 6.0.3 | ✅ 全部一致 | `market-server/package.json` |
| 6 | tsconfig 复制 market-server 严格 NodeNext 可行 | ✅ `allowImportingTsExtensions:true` 使 `.ts` import 能过 `tsc --noEmit` | `market-server/tsconfig.json` |
| 7 | `tar@7.5.22` 仓库已有 | ✅ 锁文件已有该解析槽 | `yarn.lock:22792` |
| 8 | 仓外 M-A0：位置/`AGENT_CATALOG_TOKEN`/entries/*.json、401 `口令错误`、decode 失败 404、每请求读 entries、坏文件跳过并警告、timing-safe | ✅ 全部属实（auth 已是 SHA-256+timingSafeEqual） | `agent-catalog-server/{server.mjs:17/29-36, bin.mjs:4-6, entries-store.mjs, auth.mjs}` |
| 9 | root workspaces 为显式清单；`expected-root-gate-scripts.json` 四条完整字符串、fixtureVersion 不改 | ✅ 当前 fixtureVersion:2 | 根 `package.json`、`scripts/expected-root-gate-scripts.json` |
| 10 | `verify:aa` 为既有并发债务 | ✅ | `dsh-plugin-huaanwork/package.json:216` |
| 11 | M1 资产与函数名：`writeAgentPackageAtomically`、`commitAgentPackage`、`pendingTurns`、死 `AbortController`、`cancelAgent`、`stopAllAgentPackageProcesses`、`parseAgentPackageManifest` 唯一导出 | ✅ 逐一对上；`commitAgentPackage` 在 `drafts.ts`，属 Task 8 Modify 清单 | `agent-package/store.ts:194`、`agent-package/drafts.ts:210`、`agent-package/host.ts:209/314-325/496/268-273`、`huaanwork-host/sessions.ts:295`、`agent-package/runtime.ts:383`、`agent-package/manifest.ts:49` |
| 12 | 迁移删旧键「通过 agentsHost 的旧路径原子删 `catalog:<slug>`」无需改 agents-host.ts | ✅ legacy `setEnabled(name,false)` 即 `delete map['catalog:<name>']`（原子写已有） | `huaanwork-host/agents-host.ts:517-532`（delete 在 :531） |
| 13 | `AgentPackageListItem.source:"local"|"catalog-legacy"`、`plazaCards`/`mineCards`、事件 `agent/notice`/`agent/confirm`/`agent/changed`、settings 三键、`HUAANWORK_CONTEXT_PROPS`、AgentsView 三个输入框 | ✅ 全部存在，M2 扩展点成立 | `rpc-types.ts:133/147`、`logic/agentPackagesLogic.ts`、`App.tsx:1138-1156`、`settings.ts:36-40`、`holders.ts:45`、`AgentsView.tsx:127/149/172` |
| 14 | Windows workflow「保留 M1 步骤/workflow_dispatch/timeout/verdict self-check」 | ✅ 现状吻合 | `.github/workflows/windows-agent-package-acceptance.yml` |
| 15 | 计划引用的 M1 测试文件均存在、新建文件名不冲突 | ✅ legacy/routes/runtime/store/drafts/creation/settings/sessions/agent-packages-panel/agentPackagesLogic/api/route-contract 全在；`agent-package-catalog-*.spec.ts`、`agents-plaza-m2.spec.ts` 为新名 | `dsh-plugin-huaanwork/tests/` |

「不改 market-server 运行时行为、现有测试原样通过、不得获得 `tar` 间接依赖」的边界与规格 §8.1 唯一例外条款一致；market-server 现无 `tar` 依赖，仅引入零依赖的 catalog-signing 可保持该状态。

## 二、规格覆盖判定（§8–§12）

逐节核对：无遗漏映射，也未越界做规格 §14.2「M2 之后仍不做」的事。

| 规格节 | 判定 | 备注 |
|---|---|---|
| §8.1 包与签名格式 | 覆盖 | Task 1-3；不签 tgz 字节、`.signature/` 不入 digest 清单、双槽 retiredAt 到点拒绝、与 market 逐字节一致均有测试落点 |
| §8.2 角色/凭据/状态机 | 覆盖 | 三 token 分离（桌面不持有 admin token 与私钥）；六值 publishStatus 与 §5.3 口径完全一致 |
| §8.3 服务端接口 | 覆盖 | 14 条 API 全落 Task 5/6；服务端重算 digest、slug/version 锁、重复版本 409、timing-safe、5 MiB 帽均在 |
| §8.4 审查/签名流程 | 覆盖 | CLI 独立复算+与服务端 digest 对比+`--yes` 门禁+approve 时重验冲突；迁移命令含 LAN 校验、超长 description 诚实报错不截断 |
| §8.5 安装/更新/下架/撤销 | 覆盖 | 安装 7 步、更新只升不降、下架≠撤销、启动/进页/每 60 秒刷新、离线用缓存并显示警告、无 unrevoke、移除仅目录包 |
| §8.6 审计 | 覆盖 | 服务端全请求审计（token 哈希前缀，不写 token）；桌面动作走宿主日志白名单 |
| §9.2/§9.3 RPC 与发布状态 | 覆盖 | 7 个 RPC 与规格表逐名一致；`agent/changed` 扩展、发布弹窗文案逐字采用规格句；M2 不做后台推送 |
| §10 错误处理 | 覆盖 | 文案逐条使用规格原句（含 `版本低于已安装版本，已拒绝更新`、`该版本已被管理员撤销：{reason}` 等） |
| §11 测试矩阵/真机验收 | 覆盖 | 单元/服务端集成/E2E/安全负例逐项有 Task 落点；跨机器验收较规格加严且明确反替代条款 |
| §12/§13/§14 边界与风险 | 覆盖 | 模块归属与规格 §13 一致；zero-touch、白名单 7/64/前缀 6；§14.1 M2 已接受风险在计划与 runbook 中如实呈现 |

计划自行声明的三处必要契约新增（admin 的 submission bundle 下载路由、`previousDigest` 审查对比、`migrationFrom` 元数据）均属达成规格所必需的接线；其中 `migrationFrom` 把 §8.5「包来自同一目录」操作化为「迁移 header 由服务端批准时写入 published metadata」，消除了规格的模糊点。撤销用 `revoked` 独立表示、不伪造第七种 `publishStatus`，与 §5.3 六值口径一致。

**M1 债务衔接**（对照 M1 代码评审）：

- I-2（跨标签事件归属）基线已修：`App.tsx:1140-1146` 按 `targetTabFor(eventSessionId)` 路由 `agent/notice` 与 `agent/confirm`。
- I-3（broken 包无法关闭）基线已修：`agent-package/host.ts:268-273` 仅拒绝 broken 的 enable，disable 放行。
- M-1（死 `AbortController`）由 Task 10 Step 4 修复并接入撤销取消链（保存 controller 的 active turn record）。
- 「在途 toggle 丢弃其他卡片点击」残余由 Task 12 Step 4 的 per-slug busy 守卫关闭。
- Windows 验收口径沿用 M1 后续裁定（GHA 无界面探针绿跑记 `PASS（GHA Windows 探针）`），BLOCKED/FAIL 如实记录。

**项目裁定相容性**：发布/读取 token 明文存 settings 与 M6 裁定 R-6（内网自用发行、凭据采购延后）一致；不改 Stable/Beta、不新增 variant 白名单与既有推送/变体纪律一致。

## 三、P3（建议小修——不阻断放行）

### P3-1 Task 9 Step 3 迁移规则段落原样重复两遍

「同 slug 是 legacy agent 且服务器 metadata `migrationFrom===slug` 时允许迁移替换……普通 legacy 冲突不自动迁移。」整段在 Step 3 内出现两次，属编辑缺陷。按本项目长行文档纪律，修订时删除一份，避免后续修订两处漂移。

### P3-2 「被拒」卡片动作与规格 §9.3 未对齐且未声明

规格行为「被拒 → 重新提交、详情」；计划 `packageActions` 的 rejected 落入默认分支，得到 enable/disable+publish+detail。行为本身合理（被拒的本地包仍可本地使用），但属未声明偏差，且 Task 12 Step 4 未明确被拒态按钮文案为「重新提交」。建议：Task 12 Step 4 补一句被拒卡按钮文案；Self-Review 补一行声明该偏差。

## 四、观察（可接受，无需修订）

1. **测试运行器惯例**：catalog-signing 用 `node:test`+`--experimental-strip-types`，偏离 market-server 的 vitest TS 包惯例（仓内 `node --test` 此前仅用于根 `.mjs`）。技术可行（tsconfig `allowImportingTsExtensions`、engines `^22.19.0 || >=24`），如需对齐 vitest 成本极低。
2. **第二个死 `AbortController`**：`agent-invoke.ts:256` 还有一处（M1 评审 M-1 列了两处），不在 Task 10 修复范围（只修 `agent-package/host.ts:496`）。legacy 路径无 M2 撤销语义，可留，宜登记一句。
3. **审计写放大**：每请求「整文件读-改-写」+fsync 为 O(n) 增长；内网规模可接受，规格 §8.6 未要求轮换，建议 runbook 补 audit.jsonl 增长/备份说明。
4. **首次安装限定最高 published 版本**：严于规格（规格只约束更新必须更高）；计划已声明重放拒绝理由，判定为合理收紧。

## 五、验收面判定

- **完成判定诚实**：Windows 靠 GHA 无界面探针 + BLOCKED/FAIL 如实记录，沿用 M1 后续裁定口径；「macOS 创建机 → Windows 消费机」跨机器验收较规格 §1「另一台机器」加严，且明确同机双 Profile 只算集成测试、不得替代。
- **门禁同步可行**：四条 root 门禁追加与 `expected-root-gate-scripts.json` 同步、fixtureVersion 不改（当前 2）的约束与现状吻合；`verify:aa` 并发债务复现时的处置有既有脚本与先例。
- **密钥边界**：生产私钥/生产 token 不进仓库、CI、日志、fixture；测试密钥动态生成、throwaway，与规格 §11.2 一致。

## 六、结论

**放行。** 计划可直接进入实施（按 subagent-driven-development 逐任务执行）；建议在实施首任务前对计划文本做一次小修订处置 P3-1/P3-2，并按需重跑计划自校验；观察 1-4 可在实施或 runbook 中顺手处置。本次评审未改动计划文本与任何代码。

> 2026-10-24 第二轮：P3-1/P3-2 已由修订方采纳落盘，复核见 §七；本节为第一轮历史记录。

---

## 七、修订复核（2026-10-24 第二轮）

修订方对计划文本做了一轮修订（1173→1204 行；计划仍为 untracked，代码未动）。本节为对修订版的逐项复核；除特别注明外，新断言均在基线 `168637e189` 上重新核验，修订前后差异用第一轮快照做全文 diff 取得。

### 7.1 上轮发现处置情况

| 项 | 处置 | 核验 |
|---|---|---|
| P3-1（Task 9 Step 3 重复段落） | 已修：段落现仅出现一次，并重组为「下载前先读列表→再建暂存区」顺序 | ✅ diff 确认 |
| P3-2（被拒态与规格 §9.3） | 已修：`packageActions` 新增 `if (card.publishStatus === 'rejected') return ['publish','detail']`，按钮文案固定「重新提交」，Self-Review 补安全收紧声明 | ✅ 与 §9.3「重新提交、详情」完全对齐 |
| 观察 3（审计增长） | 已处置：runbook 补增长监控与手工轮换（停服→完整备份→移走旧 `audit.jsonl`→启动重建；恢复不得旧盖新） | ✅ |
| 观察 1（node:test）/观察 2（`agent-invoke.ts:256`）/观察 4（首次安装限最高版） | 维持原状；观察 4 已在 Self-Review 声明 | 维持可接受 |

### 7.2 修订新增主张核验（全部属实，含第一轮漏检的如实补记）

修订超出上轮发现，额外修复了**第一轮评审未检出的四项真实缺陷**，其新主张经复核全部成立：

1. **verify-layout 硬编码联动（原版缺陷，第一轮漏检）**：`scripts/verify-layout.mjs:35` 用 `JSON.stringify(workspace.workspaces)` 与 12 项清单严格比对（顺序敏感），在 `check:layout` 链上；原版只改根 `package.json` 与 `expected-root-gate-scripts.json`，合入后该门必红。修订改为 Task 1/2/4/7 逐任务同步期望清单（13→14→15→16 项，`update-server` 后追加、两侧顺序一致），并在每任务验证步骤加跑 `node scripts/verify-layout.mjs`。✅ 核实清单现状恰为 12 项、`update-server` 居末位、新增次序与计划一致。
2. **内部依赖协议（原版缺陷，第一轮漏检）**：`verify-layout.mjs:101-116` 对 root+stable/beta/next/huaanwork/fabric/dsh-community-market 七个 manifest 的全部依赖字段，以正则 `^(?:workspace|portal|link):` 拒绝 `workspace:*` 等协议范围（"bypasses the published DSH package boundary"）；原版给 dsh-plugin-huaanwork 写 `workspace:*` 必红。修订改为 `"*"` 并沿用该包现有 `@huaanwork/*` 协议（现网 `@huaanwork/git-tools` 等 4 项均为 `"*"`）。✅ 核实正则与现网协议；market-server 与 agent-package-format 用 `workspace:*` 不在检查循环内，与计划文本自洽，无需改。
3. **bundle API 异步化（原版内部矛盾，第一轮漏检）**：原版 Task 3 以流式打包/解包描述实现，却声明同步函数签名并用 `assert.doesNotThrow` 断言。修订把四个 build/inspect API 统一为 `Promise`，调用点（Task 5/7/8/9）与测试断言（`await assert.rejects/doesNotReject`）全链路同步订正。✅
4. **Task 9→Task 10 前向引用消解（原版任务序缺陷，第一轮漏检）**：原版 Task 9 的 update/remove 直接调用 Task 10 才创建的 `stopAgentPackageTurnsForSlug`。修订定义 `AgentPackageTurnStopper` 结构由 Task 9 声明、Task 11 装配 `security.stopAgentPackageTurnsForSlug` 注入、测试用 fake 断言 `stopCalls` 顺序，Task 9 不再 import 未创建模块。✅

### 7.3 修订新增改进（自洽性核对通过）

- **条目/路径预算**：`MAX_AGENT_PACKAGE_ENTRIES=1024`、`MAX_AGENT_PACKAGE_PATH_BYTES=512` 在目录枚举（Task 2）与归档解包（Task 3）共用同一常量，0 字节条目不能绕过内容字节预算；含 1024 条/512 字节边界通过与 1025/513 越界拒绝用例（`/条目数超过1024/`、`/路径超过512字节/` 双端一致）及 E2E 负例。超帽归档在第 1025 条后再放绝对路径条目，断言仍报条目数错误——证明未继续解析。
- **安装事务布局**：文件写入 `.install-{slug}-{random}/package/`，`bundle.tgz`/`transaction.json` 留暂存区根部，formal 不得混入；崩溃恢复枚举五个窗口（含「旧目录已 rename、新 formal 未就位」「迁移 state 已提交、legacy 旧键未删」），迁移对账失败按失败语义回滚并保留 legacy，且明确恢复「必须先于 M1 的通用 `.old-*` 清理」。较原版覆盖完整。
- **delisted metadata 同步**：新增 `refreshInstalledCatalogPackageStatuses`（Task 9 产出、Task 11 refresh 调用）——按精确 `{slug,installedVersion}` 拉 metadata，不以列表消失推断 delisted、不伪造 revoked、网络失败保留旧状态返回 warning、`changed` 标志统一由 Task 11 发一次 `agent/changed`。补上了原版「已安装包如何得知已下架」的缺口。
- **取消链路完整化**：`AgentPackageActiveTurnRegistry`（register/cancelBySessionId/cancelBySlug/cancelAll，host.ts 产出、index 单实例注入 host/catalog-security/sessions）+ `record.cancel` 在 dispatch 闭包内实现 + 晚到 runtime/晚到 activation 两个窗口的处置（晚到者立即停/立即 dispose）+ activation.dispose 不等 graceful result + pendingTurns 释放验证。与 M1 现网结构（`pendingTurns` host.ts:209、`cancelAgent` sessions.ts:295）衔接一致。
- **state 字段保留**：`setAgentPackageEnabled` 禁止整值覆写、写回同一个 key——与现网 store.ts:131-143（整值覆写且硬编码 `local:` 键）对上，该要求是必要修复而非过度设计；`readAgentPackageFromDir`（store.ts:374，私有）引用属实；「带 `.signature` 目录无合法 catalog state 时按 catalog broken，不得回退 local」补上了 catalog 包与本地包共用 `agents/{slug}/` 目录树后 M1 列表逻辑的过滤缺口。
- **类型对齐**：客户端 `AgentPackageRevocation` 少 `actor` 字段有服务端 `Revocation={slug,version,reason,revokedAt,actor}`（计划 :549）为出处，声明自洽。

### 7.4 复审新发现

**P3-3（沿用原版、未被修订处置、第一轮亦漏检）：`packageActions` 无法产出「未安装广场卡」的 `install` 动作。** 函数返回类型联合含 `'install'`，但十个分支无一返回它；紧随其后的口径「catalog 未安装广场卡只 install/detail」与 Step 3「签名未安装卡显示……和『下载』」在给出的代码上无法同时成立——未安装签名卡若以 `source:'catalog'` 合成，将落入 `if (card.source === 'catalog')` 分支得到 enable/disable+update?/remove+detail（对未安装卡无意义且 `enabled:false` 会渲染出「启用」）。处置二选一：①给卡片补未安装判别（如 `installed` 字段），未安装返回 `['install','detail']`；②写明 plaza 未安装卡不走 `packageActions`、下载按钮由面板直接渲染。实施时 RED 测试会逼出该分歧，但按本项目纪律应在计划文本消解后再开工。

**处置（第三轮，2026-10-24，已落盘）**：按选项①修改计划 Task 12——`AgentPackageCard` 增加可选 `installed?: boolean`（仅广场未安装签名卡置 `false`，其余卡省略）；`packageActions` 在 broken 分支后、两个已安装 catalog 分支前新增 `if (card.source === 'catalog' && card.installed === false) return ['install','detail']`；Step 3 `plazaCards` 未安装卡合成 `source:'catalog'`、`installed:false`；测试口径与 Self-Review 同步。字段语义定义单点放 Step 1 引言，Step 3 只写合成约定并回指。已用 12 个分派用例（未安装/已安装/已下架/已撤销/迁移未安装/本地各发布态/legacy）验证分支行为全过；markdown 机械门禁通过。计划 1205 行，代码零改动。

### 7.5 复审结论

**维持放行。** 修订采纳了上轮全部 P3 处置与观察 3，并修复了第一轮评审未检出的四项真实缺陷（verify-layout 联动、`workspace:*` 依赖协议、异步 API 矛盾、任务序前向引用），修订质量高于原版；新发现仅 P3-3 一项（沿用原版的文本张力，非修订引入；第三轮已按选项①落盘消解，见 §7.4 处置记录）。第一轮漏检四项如实记录在案：根门禁面当时只核对了 `expected-root-gate-scripts.json` 而未通读 `verify-layout.mjs`，对依赖语法检查又因正则形式（`workspace|portal|link`）检索不全——修订方反查出这些缺口，属对本评审的实质性改进。本轮复核未改动计划文本与任何代码；第三轮仅修改计划/评审文档，代码零改动。
