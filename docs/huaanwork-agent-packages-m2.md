# 智能体包 M2 部署与离线签名 runbook

> **状态（2026-10-24，Task 13 记录）**
>
> - **macOS 双 Profile 探针：`PASS（本机探针）`。** 命令与原始 JSON 见
>   `docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md`；探针退出码 0，
>   11 个字段全为 `true`，`residualProcesses` 为 0。
> - **Windows：`BLOCKED`，不是 PASS。** 本环境不能推送分支，也就无法触发
>   `workflow_dispatch`（C21）。待执行的命令与 runbook 步骤已写入
>   `docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md`；Windows 证据文件
>   没有退出码 0 的 run，因此**不得**把它写成通过。
> - **跨机器验收（macOS 创建者 + Windows 消费机 + 离线管理员）：`BLOCKED`。** 本环境只有
>   一台机器，同机双 Profile 只算集成测试，不能替代跨机器验收。
> - 因为 macOS 与 Windows **没有都通过**，本轮 runbook **不写**“M2 双平台验收 PASS”。
>   只有两份证据都出现退出码 0 的运行后，才能改用那句话。
>
> M2 的验收面是：签名包的发布、离线审查与签名、第二 Profile 验签安装、启用与真实 HTTP
> 运行、更新保留启用态、下架后的已安装卡状态、撤销中止在途回合，以及无残留进程。它
> **不是** GUI 走查，也不是真实模型回合。

## 1. M2 组件与边界

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| 目录服务 | `agent-catalog-server/` | 内网 HTTP 目录：旧 `GET /v1/catalog` 兼容、签名包发布/下载/撤销、三 token、全请求审计 |
| 离线管理 CLI | `agent-catalog-admin/` | 审查、独立复算 digest、签名批准/拒绝、下架审批、撤销、legacy 迁移 |
| 共享签名 | `packages/catalog-signing` | canonical JSON、Ed25519、keyring/签名记录 |
| 共享包格式 | `packages/agent-package-format` | manifest、文件 digest、bundle 构建/检查/解包预算 |
| 桌面端 | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/` | 发布、下载、验签安装/更新/移除、运行前复验、撤销缓存、七条 M2 RPC |

边界：

- 目录服务**只持公钥**。它没有私钥配置项，也不读任何私钥路径。
- 签名只发生在**离线签名机**上，由 `agent-catalog-admin approve` 完成；桌面端与目录服务
  都没有签名能力。
- 桌面端只从设置面读取**读 token / 发布 token**（见 §5），管理 token 不下发到用户机器。
- 下架（delist）只改目录 metadata 与已安装卡状态，**不是**安全处置；撤销（revoke）才是
  （见 §8）。运行前的签名复验与撤销门在每次 `@slug` 运行时都重新执行。

## 2. 目录布局与备份对象

服务端只有一个 `dataDir`：

```
{AGENT_CATALOG_DATA_DIR}/
  state.json                          # 唯一持久状态(提交、已发布包、下架申请、撤销)
  audit.jsonl                         # 全请求审计,追加式,每行一条 JSON
  submissions/{submissionId}/bundle.tgz
  packages/{slug}/{version}/bundle.tgz
```

`{AGENT_CATALOG_ENTRIES_DIR}` 是旧 M-A0 条目目录（只读，按请求重新枚举），**不属于**本服务
的状态；迁移后由运营方自行决定是否清理。部署时 `entries/` 与 `dataDir` 都应放在**仓库
之外**的运维目录（例如 `/srv/huaanwork/...`），不要放在源码树里：升级/重新部署代码时不应
连带移动或删除目录数据。

备份 = `dataDir` 的**完整**快照。`state.json` 损坏时服务端 fail-closed（`StoreCorruptError`，
文件保持原样），必须从备份恢复后重启。

## 3. 启动服务（可复制示例）

三个 token 长度至少 32 字符，且**两两不同**：读 token 泄露不能发布，发布 token 泄露不能
审批。下面的值全部是明显的测试占位名，**不要**在生产里照抄。

macOS / Linux（bash）：

```bash
export AGENT_CATALOG_ENTRIES_DIR=/srv/huaanwork/agent-catalog/entries
export AGENT_CATALOG_DATA_DIR=/srv/huaanwork/agent-catalog/data
export AGENT_CATALOG_KEYRING_PATH=/etc/huaanwork/agent-catalog-keyring.json
export AGENT_CATALOG_TOKEN='TEST-PLACEHOLDER-READ-token-replace-me-32chars'
export AGENT_CATALOG_PUBLISH_TOKEN='TEST-PLACEHOLDER-PUBLISH-token-replace-me-32chars'
export AGENT_CATALOG_ADMIN_TOKEN='TEST-PLACEHOLDER-ADMIN-token-replace-me-32chars'
export HOST=0.0.0.0
export PORT=18080

node --experimental-strip-types agent-catalog-server/src/index.ts
```

Windows PowerShell（同一组变量；私钥仍然只在离线机）：

```powershell
$env:AGENT_CATALOG_ENTRIES_DIR = 'D:\huaanwork\agent-catalog\entries'
$env:AGENT_CATALOG_DATA_DIR    = 'D:\huaanwork\agent-catalog\data'
$env:AGENT_CATALOG_KEYRING_PATH = 'C:\huaanwork\agent-catalog-keyring.json'
$env:AGENT_CATALOG_TOKEN         = 'TEST-PLACEHOLDER-READ-token-replace-me-32chars'
$env:AGENT_CATALOG_PUBLISH_TOKEN = 'TEST-PLACEHOLDER-PUBLISH-token-replace-me-32chars'
$env:AGENT_CATALOG_ADMIN_TOKEN   = 'TEST-PLACEHOLDER-ADMIN-token-replace-me-32chars'
$env:HOST = '0.0.0.0'
$env:PORT = '18080'

node --experimental-strip-types agent-catalog-server/src/index.ts
```

启动失败一律 exit 1 并打印缺项（缺目录、缺 token、token 太短或重复、keyring 不可读/非法）。
启动成功会打印监听地址、条目目录、数据目录与 keyring 公钥数量，**不打印任何 token**。

目录服务的读侧（`GET /v1/catalog*`、已发布包列表/元数据/bundle、撤销列表）用读 token；
提交与下架申请用发布 token；审查/批准/拒绝/撤销用管理 token。`/v1/agent-packages` 的公开
读路由仍要求有效读 token：没有匿名读取。

## 4. keyring、私钥与轮换纪律

- **IT 下发**（不是用户填写）：把公钥 keyring 写到每个需要安装/运行的 Profile：
  `{profileDir}/agent-catalog-keyring.json`，格式：

  ```json
  {
    "schemaVersion": 1,
    "keys": [
      { "keyId": "<sha256-hex-64>", "publicKeyHex": "<raw-32-byte-hex-64>", "slot": 1 }
    ]
  }
  ```

  `keyId` **必须**等于 `sha256(raw public key bytes)` 的 64 位十六进制（即
  `fingerprintPublicKeyHex(publicKeyHex)`）。`slot` 只能是 1 或 2；恰好一个 slot 1，最多
  一个 slot 2。文件缺失或非法时，**只有**目录包安装与运行 fail-closed，本地包与 legacy
  不受影响。
- **私钥只在离线签名机**（PKCS#8 PEM，`chmod 0600`）。它从不进 git、不进 Profile、不进
  目录服务、不进桌面设置。`approve` 只在回执校验与 `--yes` 之后才读取它。
- **双槽轮换**：新公钥以 slot 1 写入 keyring，旧公钥保留为 slot 2；下一次发版把 slot 2
  移除或写上 `retiredAt`。轮换**只经配置与发版**，桌面端**没有** keyring 编辑 UI。撤销
  名单见 §8。
- **测试 key 与生产 key 不共用**：本仓库的所有 keyring/私钥都是每次运行生成的临时材料；
  CI 或验收探针里的 key 永远不能进生产 keyring。生产 keyring 的公钥数量应与备份链上的
  记录一致。

## 5. 桌面端配置（用户可见）

设置面只暴露两项：

| 设置 | 用途 |
| --- | --- |
| 目录读 token | 列表、下载、撤销列表 |
| 目录发布 token | 提交审查、查询自己的提交、申请下架 |

管理 token 不下发到桌面。目录 host/port 走现有 `agents_host` / `agents_port`，只允许本机或
内网地址；目录不可达时只影响广场，本地智能体不受影响。

## 6. 发布 → 离线审查 → 签名

创建者在桌面「我的智能体」提交发布后，运营方在**离线签名机**上：

```bash
export AGENT_CATALOG_URL='http://catalog.internal.example:18080'
export AGENT_CATALOG_ADMIN_TOKEN='TEST-PLACEHOLDER-ADMIN-token-replace-me-32chars'
export AGENT_CATALOG_TOKEN='TEST-PLACEHOLDER-READ-token-replace-me-32chars'
export AGENT_CATALOG_PUBLISH_TOKEN='TEST-PLACEHOLDER-PUBLISH-token-replace-me-32chars'

# 1) 待审队列
node --experimental-strip-types agent-catalog-admin/src/cli.ts pending

# 2) 下载并独立复算 digest，写审查回执 review.json
node --experimental-strip-types agent-catalog-admin/src/cli.ts review <submissionId> --out ./review-<submissionId>

# 3) 明确同意后签名并发布（--slot 1 或 2）
node --experimental-strip-types agent-catalog-admin/src/cli.ts approve <submissionId> \
  --review ./review-<submissionId>/review.json \
  --private-key /secure/offline/signing-key.pem --slot 1 --yes

# 拒绝（原因必填，1–500 字符）
node --experimental-strip-types agent-catalog-admin/src/cli.ts reject <submissionId> --reason '说明不合规的原因'

# 下架申请：列出 / 批准 / 驳回
node --experimental-strip-types agent-catalog-admin/src/cli.ts delist-requests
node --experimental-strip-types agent-catalog-admin/src/cli.ts delist-approve <requestId>
node --experimental-strip-types agent-catalog-admin/src/cli.ts delist-reject <requestId> --reason '原因'

# 撤销一个版本（不可撤回；已安装副本在下次刷新撤销列表后禁用）
node --experimental-strip-types agent-catalog-admin/src/cli.ts revoke <slug> <version> --reason '安全原因'
```

`review` 与服务端**各自独立**复算 digest；字节不一致时拒绝写回执。`approve` 校验回执的
`digestSha256` 与服务端当前 digest，任何变化都拒绝签名。CLI 的任何输出都不含 token 与私钥。

## 7. 安装、更新、启用

- 安装只接受该 slug **当前最高 published 版本**；直接请求旧版本按重放拒绝。首次安装默认
  **关闭**，需要用户启用。
- 更新只向上；低于已安装版本按降级拒绝；目录最新版本已下架/撤销时不下载。
- 更新与移除在改名之前先中止该 slug 的在途回合。
- 已安装副本在每次 `@slug` 运行前都会从磁盘重新验签并检查撤销列表，两类失败文案不同：
  **签名或 digest 失败**报 `包校验失败，未安装或未运行。请联系管理员`；**命中撤销列表**
  报 `该版本已被管理员撤销：<原因>`。
- 已安装包的发布状态按**精确 metadata**刷新：下架写 `publishStatus:'delisted'`，撤销交给
  撤销应用写 `enabled:false` + `revoked`。不会因为列表里消失就推断下架。

## 8. 下架不是安全处置；撤销与离线风险

- **下架（delist）**只影响目录可发现性与已安装卡片的 `publishStatus`；已安装副本**仍然
  可以运行**。这一点由 M2 探针显式验证（`delistedInstalledStillRan: true`）。
- **撤销（revoke）**是安全处置：桌面端刷新撤销列表后，命中 `catalog:<slug>` +
  `installedVersion` 的条目立刻写 `enabled:false` + `revoked`，并中止在途回合。
- 撤销列表缓存在 `{profileDir}/agent-catalog-revocations.json`。目录**不可达**时使用**上次
  成功拉取**的列表继续执行撤销；缓存损坏时备份为 `.corrupt-<timestamp>` 并告警，**绝不**
  当空列表放行。
- **离线期间的撤销可能延迟**：没有后台推送，撤销在客户端下次刷新列表时才落地。客户端长
  期离线时，已安装副本不会自动失效——这是已知的延迟窗口，不是被撤销版本的“已安全”状态。
- 撤销不可撤回。误发撤销只能发新版本重新签名发布。

## 9. 审计：位置、增长、归档、轮换与恢复

- 位置：`{AGENT_CATALOG_DATA_DIR}/audit.jsonl`，一行一条 JSON。**每个请求**（含 401/403/
  404/405、未知路由、处理失败）在响应写出之前落盘；审计写不进去时服务端返回
  `500 audit-write-failed`，写请求不会在无审计记录的情况下成功。
- 字段：`timestamp / action / outcome / status / actor / slug? / version? / submissionId? /
  delistRequestId? / reason?`。`actor` 只是 token 的 SHA-256 前 12 位，不存 token；自由文本
  中的三个 token 被替换成 `[REDACTED]`，PEM 私钥块（含未终止的块）被替换成
  `[REDACTED PRIVATE KEY]`。
- **增长**：每次追加都是「读旧文件 → 追加一行 → 写临时文件 → fsync → rename」，因此单次
  写入成本随文件大小线性增长。它适合按周/按月人工归档，不适合长期不轮换的大文件。
- **增长监控**（运营方自建，服务本身不报警）：定期记录 `audit.jsonl` 字节数与行数，同时
  记录 `state.json` 的条目数（`packages` 个数、`submissions` 个数）与每日/每周增量。容量
  结论必须由这些**实际数字**得出，并在备份窗口（下一次完整备份到恢复演练）内复核；
  不要把“内网规模可接受”当成已实测结论。
- **手工归档 / 轮换**（固定三步，不新增自动日志框架）：
  1. **停服**（停止 `agent-catalog-server`；期间目录不可用，桌面端只影响广场）。
  2. **完整备份** `dataDir`（含 `state.json`、`audit.jsonl`、`submissions/`、`packages/`）。
  3. **移走旧 `audit.jsonl`**（改名或移到归档位置，不要删除），然后**启动服务**；服务会
     重建一个新的空 `audit.jsonl`。
- **恢复纪律**：恢复时**不得**用旧备份覆盖较新的审计或 `state.json`。备份只用于“当前文件
  丢失或损坏”的场景；若备份比现网旧，只取缺失部分（例如只补 `packages/` 下的 bundle），
  绝不回滚 `state.json` 与 `audit.jsonl`。
- 威胁模型里的诚实边界：审计日志本身**没有**独立的完整性保护（没有远端只追加存储、没有
  签名链）。持有管理 token 的人可以停服，而停服动作本身不在本该保护它的日志里。需要更强
  证据时，把归档文件复制到只追加的备份介质，并在离线签名机上人工记录审批动作。

## 10. 上限与排障文案

| 项 | 上限 | 超限时的表现 |
| --- | --- | --- |
| 签名 bundle（上传/下载） | **5 MiB** | 服务端拒绝超大上传；桌面端报 `智能体包超过 5 MiB 上限` 并删除临时文件 |
| 解包后内容总量 | **5 MiB**（外加每条 1 KiB 头预算） | 解包中途中止，按包结构错误拒绝 |
| bundle 与目录枚举条目数 | **1024** | `包结构非法：条目数超过1024`；0 字节条目同样计数，不能靠空文件绕过内容预算 |
| 规范化路径长度 | **512 字节** | `包结构非法：路径超过512字节` |
| 目录 JSON 响应 | **1 MiB** | 客户端报 `目录响应超过 1 MiB 上限` |
| persona / SKILL.md | 各 32 KiB | 包结构错误，拒绝提交/安装 |
| 工具入口文件 | 各 256 KiB | 同上 |
| 整包（manifest+人设+技能+入口） | 5 MiB | 同上 |
| 审查原因 | 1–500 字符 | CLI 用法错误（exit 2） |

**评审 C9 的后果：签名条目计入同一个 1024 条目帽。** unsigned 检查只数内容条目，
而签名 bundle 会再追加 `.signature/package-digest.json` 与 `.signature/signature.json`；
两者与内容共用 `MAX_AGENT_PACKAGE_ENTRIES = 1024`。因此处在边界的内容包**能通过提交
（unsigned 检查），却在审批/签名阶段失败**：2026-10-24 以真实构建路径实测，1022 条内容
（含 `agent.json`、`persona.md`）仍可通过验签，**1023–1024 条内容**的包 unsigned 通过，
`buildSignedAgentPackageBundle` / `inspectSignedAgentPackageBundle` 报
`包结构非法：条目数超过1024`。发布者应把内容条目控制在 **1022 条以内**，不要把 1024
当成可用预算。评审原文给出 1022–1024 的区间；本次实测把下界订正为 1023（1022 仍通过），
“边界包会在审批阶段失败”的结论不变。回归钉见
`packages/agent-package-format/tests/bundle.test.ts` 的
「counts signature entries against the shared 1024 entry cap」。

其它高频文案：

| 文案（原话） | 含义 | 处置 |
| --- | --- | --- |
| `包校验失败，未安装或未运行。请联系管理员` | 缺 keyring、未知/退休 key、篡改、digest 不符、bundle 缺失 | 重新下发 keyring 或重新安装；不要手工改包内文件 |
| `目录口令错误或权限不足` | 桌面端读/发布 token 错误，或 token 角色不对 | 核对设置面 token 与 keyring；管理 token 不下发桌面 |
| `目录不可达，请稍后重试；本地智能体不受影响` | 目录 host/port 不可达或非内网地址 | 检查网络与设置；离线时按上次撤销列表继续执行 |
| `该版本已被管理员撤销：<原因>` | 运行前复验命中撤销 | 移除后安装新版本；撤销不可撤回 |
| `该版本不是目录中的最新版本，已拒绝安装` | 首次安装请求了旧版本（重放） | 安装当前最高 published 版本 |
| `版本低于已安装版本，已拒绝更新` | 降级 | 只能向上更新，或先移除再安装 |
| `目录中没有版本 <x>` / `目录中没有智能体 @<slug>` | 未发布、已下架/撤销，或 slug 拼错 | 到广场确认已发布版本 |
| `智能体 @<slug> 已安装，无需重复安装` | 重复安装 | 用更新或移除 |
| `智能体状态已变化，请刷新后重试` | 网络等待期间本地内容/提交/版本改变 | 刷新后重试 |
| `只有已发布的版本可以申请下架` | 本地条目还没有发布成功 | 先确认审查已批准并刷新发布状态 |
| `该版本已下架，无法安装` / `该版本已撤销，无法安装` | 目标版本状态不允许下载 | 选已发布版本 |
| `审计写入失败` | `audit.jsonl` 不可写/磁盘满 | 停服检查磁盘与权限；服务在写请求上 fail-closed |
| `撤销缓存已损坏，已备份为 <文件名>，未按空列表处理` | 本地撤销缓存损坏 | 保留备份取证；联网后刷新撤销列表 |

## 11. 撤销列表的离线语义（运维须知）

- 客户端唯一的周期刷新由桌面 UI 触发；没有后台推送、没有跨设备同步。
- 目录不可达：沿用上次成功缓存的撤销列表；缓存缺失/损坏时**不**假设“没有撤销”。
- 因此“离线机器上撤销已生效”不能承诺。需要即时生效时，让机器连回目录一次，或按 §13 的
  应急流程下线该包。

## 12. Windows 沙箱边界

- Windows 上沙箱自报 `enforcement: partial` 是**已接受事实**；M1 的 Windows 探针必须记录该值。
- 沙箱**只限制写**：读取工作区外文件与访问网络**不隔离**。签名与审查是**来源**控制，
  不是运行时隔离。
- 沙箱不可用时 fail-closed（`当前系统无法启动沙箱，智能体未运行`）。

## 13. legacy 迁移仍需审查

旧 `catalog-legacy` persona 条目可以生成最小智能体包，但**不会自动发布**：

```bash
node --experimental-strip-types agent-catalog-admin/src/cli.ts migrate-legacy <slug>
# 生成 agent.json + persona.md 并打印摘要；不提交
node --experimental-strip-types agent-catalog-admin/src/cli.ts migrate-legacy <slug> --submit
# 生成并提交审查；仍显示「未自动批准：请先运行 review 与 approve。」
```

- `migrate-legacy` 自身不读私钥、不签名；`--submit` 只是把最小包提交到同一审查队列。
- 之后必须照常 `pending` → `review` → `approve`。**客户端成功安装新包之后**，才删除旧
  `agents-enabled.json` 的 `catalog:<slug>` 键；迁移成功后由安装事务自动删除该键，不要在
  客户端安装成功前手工删除，否则旧条目会先消失、新包还没装上。
- legacy 条目与新签名包重名时，只有 `migrationFrom` 匹配的提交才允许迁移；普通重名一律
  拒绝安装。

## 14. 双 Profile 验收探针

同机双 Profile（创建者 + 消费者）是**集成测试**，不替代跨机器验收。

macOS：

```bash
node --experimental-transform-types dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin.json
```

Windows（GHA，`workflow_dispatch`）：

```bash
node --experimental-transform-types dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform win32 --out windows-agent-package-m2-acceptance.json
```

> `--experimental-transform-types` 是必需的：探针静态 import `src/huaanwork-host/routes.ts`，
> 其 `RouteError` 使用 TypeScript 参数属性，strip-only 模式无法加载（会以
> `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 在 import 阶段失败）。该 flag 只改变 TS 语法转译方式，
> 不改变探针逻辑或断言；admin CLI 子进程仍用 `--experimental-strip-types`。

退出码：`0` PASS；`1` FAIL（字段为 false 或断言失败，报告里有 `error` / `failedField`）；
`3` BLOCKED（服务/环境起不来）；`2` 用法错误（含在非对应平台把结果标成 darwin/win32）。
探针自己起真实 `agent-catalog-server`（临时 entries/data/keyring），生成一次性 Ed25519
测试 key，用真实 CLI 子进程审查/签名，在第二个 Profile 安装、启用并跑**真实 HTTP** fixture，
随后发布 1.0.1、更新、下架、撤销，最后扫描命令行引用临时目录的残留进程并要求为 0。

平台字段必须与 `process.platform` 一致：darwin 的结果不能标成 win32。

## 15. 验收记录与状态

| 平台 | 状态 | 证据 |
| --- | --- | --- |
| macOS 双 Profile 探针 | `PASS（本机探针）` | `docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md` |
| Windows GHA 探针 | `BLOCKED`（未运行；本环境不能 push/触发 workflow） | `docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md` |
| 跨机器验收（macOS 创建者 + Windows 消费机 + 离线管理员） | `BLOCKED`（只有一台机器） | 同上两份证据的“跨机器”章节 |

出现 Windows 退出码 0 的 run 之后，把 run URL 与原始 JSON 追加到 Windows 证据文件；只有
macOS 与 Windows **都**为 PASS 时，才可以把状态改成“M2 双平台验收 PASS”。跨机器验收仍需
两台机器各留原始证据与进程清单。
