# 技能中心双标签与内网共享流转设计规格

- 日期：2026-11-14
- 状态：已实施（2026-11-15）。Windows 真机矩阵按 R-ACCEPT-1 方式记 **waiver**（无 Windows 主机，未验证真实 Windows 边界，不得写成通过）；补跑触发与残余风险见 `docs/evidence/2026-11-14-skill-center-catalog.md` §6
- 基线：外层仓库 `9d5a7a0f75e195e41179e4c7ad94003659038567`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`0.2.1-rc.1`）
- 范围：HuaAnWork 技能中心、我的技能、显式 `/` 调用、内网共享技能目录、相关持久化与迁移
- 约束：不修改 `deepseek-harness/`；所有桌面行为改动落在 HuaAnWork 自有代码与 Profile 组合层

## 1. 背景与现状结论

当前技能页有“全部、内置、外部、我创建的”四个标签。标签只是对同一份三源列表的前端筛选：

- 内置技能来自应用安装包内的 `dsh-plugin-huaanwork/skills/`。
- 用户技能来自 `<profileDir>/skills/`。
- 外部技能来自 `$DSH_AGENTS_HOME/skills`，缺省为 `~/.agents/skills`。
- 内置非系统技能通过 `<profileDir>/skill-toggles.json` 启停；用户和外部技能没有启用门，始终可显式调用。
- 顶部“上传技能”实际是本地文件导入，不存在技能远端上传或下载接口。
- 显式 `/name` 的 Host 解析顺序为“用户 → 外部 → 内置”，仅内置技能检查开关。
- standard、ptc、cordis preset 的文件技能 Provider 还可能扫描外部根；只删除 UI 标签不能关闭这条运行路径。

因此，本需求不是单纯重命名标签。它把技能管理改成“共享目录、本地副本、本地启用”三个相互独立的状态面。

## 2. 目标与非目标

### 2.1 目标

1. 页面只保留“技能中心”和“我的技能”。
2. 技能中心展示应用内置技能与内网共享技能。
3. 我的技能展示本机创建、导入、下载的技能。
4. 中心普通技能通过“下载”生成本地副本；下载后默认未启用。
5. 我的技能通过“启用/已启用”控制显式 `/` 调用，Host 必须执行同一启用门。
6. 我的技能通过“上传”向内网中心发布快照；上传即发布，不进入审核队列。
7. 外部技能不再自动展示或调用，只能先导入为我的技能，再显式启用。
8. 内网不可用时，本地技能、启停和 `/` 调用不受影响。
9. 升级不删除外部文件，不静默覆盖同名本地技能，并尽量保留既有可用状态。

### 2.2 非目标

- 不建设公共互联网技能市场。
- 不引入技能审核、拒绝、下架申请、撤销或管理员审批状态机。
- 不复用智能体包的 Ed25519 签名、keyring、离线签名机或运行前验签流程。
- 不在下载或上传时执行技能脚本。
- 不自动同步外部目录，不自动上传本地修改，不自动更新已下载副本。
- 不删除中心条目后远程删除本地副本。
- 不改造模型自主技能选择的产品规则；本规格的启用验收以 HuaAnWork 显式 `/` 调用为准。preset 的外部扫描必须关闭，以防绕过外部技能新规则。
- 不修改上游 `deepseek-harness/` 子模块。

## 3. 已确认的产品裁定

| 编号 | 裁定 |
| --- | --- |
| R1 | 技能中心是内网共享技能库，不是仅本机视图，也不是公共市场 |
| R2 | 上传校验成功后立即发布，无需人工审核 |
| R3 | 外部技能须先经本地导入进入我的技能，启用后才进入 `/` 列表 |
| R4 | 下载和上传都是复制/发布快照，中心与本地互为独立副本 |
| R5 | 启用是本机状态，不上传、不共享、不随下载自动开启 |
| R6 | 原顶部“上传技能”保留本地导入能力，文案改为“导入技能” |
| R7 | 我的技能启用后即可 `/` 调用；不暴露“禁止用户手动调用”选项，`user-invocable: false` 不作为 HuaAnWork 手动调用禁用依据 |

## 4. 方案取舍

### 4.1 采用：目录快照 + 本地副本

中心保存共享条目及历史 revision；下载把指定 revision 复制到当前 Profile，上传把当前本地内容发布为新 revision。优点是支持多人下载、离线本地使用、明确冲突和独立启停。

### 4.2 排除：移动语义

下载后删除中心条目、上传后删除本地条目会导致共享技能被首个消费者取走，也无法支持本地下载后继续使用，不采用。

### 4.3 排除：把用户技能写回安装包内置目录

安装目录可能只读，且应用升级会覆盖内容，更不能形成内网共享，不采用。

### 4.4 服务复用边界

复用 `agent-catalog-server` 的进程、内网地址、read token、HTTP 错误和审计基础设施，新增独立 `/v1/skills` API、`SkillStore` 与技能审计日志。技能不复用智能体包 manifest、submission、签名或包状态。

## 5. 页面与交互规格

### 5.1 标签和页面级动作

标签顺序固定为“技能中心、我的技能”，默认选中技能中心。页面标签类型为 `SkillTab = "center" | "mine"`，不得再直接复用存储来源作为标签值。

- 技能中心：显示搜索、刷新和中心卡片。
- 我的技能：显示搜索、“导入技能”“创建技能”和本地卡片。
- 搜索只作用于当前标签；切换标签可保留各自查询词，但不得执行跨页聚合搜索。
- 删除“全部”和“外部”标签、空态分支及其测试。
- 卡片 key 必须包含来源或稳定身份，不能只使用技能名。

### 5.2 技能中心卡片

中心条目来源为 `bundled` 或 `catalog`，显示名称、描述和“内置/共享”徽标；共享条目还显示发布者、revision 和更新时间。共享条目的“查看”按精确 revision 下载归档做只读预览，不写入我的技能、不改变启用状态。

普通条目按钮：

- 查看。
- 下载：本地不存在该来源副本时可用。
- 已下载：本地同来源、同 revision、同摘要副本存在时为禁用状态。
- 更新：同来源本地副本落后于中心最新 revision，且本地没有未上传修改时可用。
- 本地有修改：同名本地内容与待下载来源冲突，或下载副本存在未上传修改时显示为禁用状态；不得自动覆盖。

中心不再显示普通内置技能的启用按钮。系统技能 `explore`、`test-fix` 显示“系统技能·始终启用”，不提供下载；内部技能 `create-agent` 继续不列出。

### 5.3 我的技能卡片

本地条目来源固定为 `user`，显示名称、描述、来源徽标和启用状态。来源徽标为“创建、导入、内置副本、共享副本”之一。

按钮与规则：

- 查看、编辑、删除沿用现有入口。
- 启用/已启用沿用现有切换交互；再次点击“已启用”表示禁用。
- 上传：首次发布或发布本地修改。
- 已上传：服务器最新已发布 revision 的摘要与当前本地内容一致时显示为禁用状态。
- 更新上传：当前发布者拥有该共享名称且本地摘要已变化时显示。
- 上传不改变本地启用状态，也不自动打开中心或我的技能以外的页面。
- 与当前内置技能同名的本地副本不允许首次上传占用该名称；卡片提供“另存为新技能”，复制正文与资源为新名称、来源 `created`、默认未启用，再允许上传。
- 创建/编辑表单移除“禁止用户手动调用”选项；启用开关是手动 `/` 调用的唯一产品门。`disable-model-invocation` 暂保留为模型自动调用策略元数据，不影响显式 `/` 调用。

### 5.4 反馈与空态

- 创建成功：`已保存技能 <name>，请在“我的技能”中启用`。
- 导入成功：`已导入技能 <name>，请在“我的技能”中启用`。
- 下载成功：`已下载技能 <name>，请在“我的技能”中启用`。
- 启用成功：`已启用技能 <name>，可在对话框输入 / 调用`。
- 禁用成功：`已禁用技能 <name>`。
- 上传成功：`已发布技能 <name>（revision <n>）`。
- 中心远端失败：保留内置和缓存共享条目，显示 `共享技能库不可用，当前显示内置技能与已缓存内容`；无缓存时不得虚构缓存。
- 我的技能读取不依赖中心请求成功。
- 我的技能无条目且无搜索词时，保留创建入口，并增加导入指引。

## 6. 核心数据模型

### 6.1 客户端与 Host 投影

```ts
export type SkillTab = "center" | "mine";
export type SkillSource = "bundled" | "catalog" | "user";

export type SkillDownloadState =
  | "available"
  | "downloaded"
  | "update-available"
  | "local-conflict"
  | "not-applicable";

export type SkillOrigin =
  | { kind: "created" }
  | { kind: "imported" }
  | { kind: "bundled" }
  | {
      kind: "catalog";
      name: string;
      revision: number;
      publisher: string;
      digest: string;
    };

export type CenterSkillInfo = {
  name: string;
  description: string;
  source: "bundled" | "catalog";
  whenToUse?: string;
  revision?: number;
  publisher?: string;
  digest?: string;
  updatedAt?: string;
  downloadState: SkillDownloadState;
};

export type LocalSkillInfo = {
  name: string;
  description: string;
  source: "user";
  whenToUse?: string;
  enabled: boolean;
  origin: SkillOrigin;
  contentDigest: string;
  publishedRevision?: number;
  publishedDigest?: string;
  publishState: "not-published" | "published" | "modified";
};

export type InvocableSkillInfo = {
  name: string;
  description: string;
  source: "bundled" | "user";
  enabled: true;
  originKind?: SkillOrigin["kind"];
};

export type SkillDetail = {
  name: string;
  description: string;
  source: SkillSource;
  whenToUse?: string;
  content: string;
  disableModelInvocation?: boolean;
  /** 原始 frontmatter 元数据；不进入表单，也不参与手动调用门。 */
  userInvocable?: boolean;
  origin?: SkillOrigin;
  enabled?: boolean;
};
```

`SkillDetail` 是 `skill.get` 的只读详情模型，不要求携带 `downloadState`、`publishState` 等列表 UI 状态；列表投影与详情投影分离，避免 Host 读路径被迫计算页面按钮状态。

`CenterSkillInfo` 与 `LocalSkillInfo` 不合并成大量可选字段的单一卡片类型。共享目录条目永远没有本地 `enabled` 含义；只有系统内置和本地技能能进入 `InvocableSkillInfo`。

### 6.2 本地持久化

新增两个 per-profile 文档：

1. `<profileDir>/user-skill-toggles.json`：只保存 `enabled=true` 的本地技能名；缺失键即禁用，采用临时文件 + rename 原子写。
2. `<profileDir>/skill-local-state.json`：保存本地来源、当前内容摘要和发布快照。

```ts
export type SkillLocalStateDocument = {
  schemaVersion: 1;
  migration?: { version: 1; completedAt: string };
  skills: Record<string, {
    origin: SkillOrigin;
    contentDigest: string;
    publishedRevision?: number;
    publishedDigest?: string;
  }>;
  migrationWarnings?: string[];
};
```

`skill-local-state.json` 不是技能正文，不随归档上传。所有创建、导入、应用内编辑、下载和删除必须同事务边界地更新该文档；删除技能还要删除其用户启用键。

本地创建/导入的名称只与既有我的技能、系统技能和内部保留名冲突；普通中心技能同名不构成创建/导入冲突，因为中心与本地允许同名副本。首次上传仍须遵守 §7.2 的内置名称占用检查。

对于用户在应用外直接修改技能文件的情况，上传前必须重新读取目录并计算摘要；若与 `contentDigest` 不同，以最新磁盘内容为准并刷新本地状态，不能继续上传旧快照。

### 6.3 共享记录与 revision

服务端以技能 `name` 作为共享身份，以单调递增整数 `revision` 作为版本。首个 revision 为 1。

```ts
export type SkillRevisionRecord = {
  name: string;
  revision: number;
  description: string;
  whenToUse?: string;
  publisher: string;
  digest: string;
  archivePath: string;
  size: number;
  createdAt: string;
};

export type SkillSeries = {
  name: string;
  owner: string;
  latestRevision: number;
  revisions: Record<string, SkillRevisionRecord>;
};
```

状态和归档分开放置：

- `<dataDir>/skills/state.json`
- `<dataDir>/skills/archives/<name>/<revision>.tar.gz`
- `<dataDir>/skills/audit.jsonl`
- `<dataDir>/skills/audit-intents.jsonl`

状态写队列按名称串行化；归档先写临时文件并 fsync/rename，状态提交后条目才可见。历史 published revision 保留并可按精确 revision 下载。

## 7. 内网技能目录 API

所有 JSON 错误使用 `{ error, code? }`。GET 使用现有 `agents_catalog_token` 对应的 read token；上传使用独立技能上传 token。地址和端口复用 `agents_host`、`agents_port`，桌面仍执行现有 LAN 校验。

### 7.1 路由

| 方法 | 路径 | 权限 | 行为 |
| --- | --- | --- | --- |
| GET | `/v1/skills?cursor=<cursor>&limit=<n>` | read | 返回每个名称最新 revision，按 name 排序 |
| GET | `/v1/skills/{name}/{revision}` | read | 返回精确 revision 元数据 |
| GET | `/v1/skills/{name}/{revision}/archive` | read | 返回对应 `.tar.gz` |
| POST | `/v1/skills/{name}` | skill-publish | 校验归档并立即发布 |

列表 `limit` 默认 100、合法范围 1–100；响应含 `items` 和可选 `nextCursor`。Host 逐页读取，无 `nextCursor` 才算完整；最多 1000 页作为坏服务端止损，超过后返回明确目录错误，不展示截断结果为完整目录。

### 7.2 上传请求与响应

- URL 中的 `name` 必须符合现有 kebab-case 规则且不超过 64 字符。
- body 是原始 `.tar.gz`，`Content-Type: application/gzip`。
- 新名称不得携带 `X-Skill-Expected-Revision`。
- 更新必须携带 `X-Skill-Expected-Revision: <latestRevision>`。
- 新发布返回 201 `{ skill, created: true }`。
- 最新 revision 同发布者、同摘要的重复上传返回 200 `{ skill, created: false }`，不新增 revision；该判断先于 expected-revision 冲突，使首次上传响应丢失后的无 expected-revision 重试也能幂等成功。

冲突规则：

| 情况 | 响应 |
| --- | --- |
| 新上传但名称已存在 | 409 `skill-already-exists` |
| 非 owner 更新 | 409 `skill-name-conflict` |
| `expectedRevision` 不是当前最新值 | 409 `skill-revision-conflict` |
| 名称、正文、归档或预算非法 | 400 `invalid-skill` / `skill-too-large` |
| 上传 token 缺失或未知 | 401 `口令错误` |
| 有效凭据但无技能上传权限 | 403 `forbidden` |

桌面 Host 在上传前拒绝与当前应用普通内置技能同名的首次发布，避免中心出现同名内置/共享条目。服务端仍独立保证共享名称唯一。若旧客户端或异常部署已经产生同名记录，桌面按 `source:name` 保留两张卡并显示来源，不覆盖、不删除任何数据。

### 7.3 发布者身份

现有共享 `agents_catalog_publish_token` 不能区分上传者，且同时授予智能体包提交权限，因此不得用于技能上传。

新增：

- 服务端 `AGENT_CATALOG_SKILL_UPLOADERS`：JSON 对象，键为发布者 id，值为至少 32 字符的 token。
- 发布者 id 规则：`^[a-z0-9][a-z0-9._-]{0,63}$`。
- 所有上传 token 必须彼此不同，且不得与 read/publish/admin token 重复。
- 桌面 `AppSettings` 新增 `agents_skill_upload_token`，默认空字符串；设置页增加“技能上传口令”。
- owner/publisher 由服务端根据 token 得出，绝不接受客户端自报 publisher。
- 认证必须对所有配置 token 做等长摘要比较后再判定；日志只记录 token 的既有 12 位哈希 actor，业务记录保存非秘密 publisher id。

空上传 token 或缺失服务端映射只禁用上传，不影响浏览、下载、本地技能和 `/` 调用。

### 7.4 审计坐标与脱敏

技能路由复用现有审计字段：`slug` 记录技能 `name`，`version` 记录 `String(revision)`；不新增 `name/revision/digest` 审计字段。`secretList(config)` 必须包含 read/publish/admin token 与全部技能上传 token；技能审计日志与 HTTP 异常脱敏共用该集合。路由按 `audit: 'agent' | 'skill'` 选择审计日志，覆盖 403/405、审计不可用、write intent、handler 异常和 finish；未匹配路由的 401/404 归入智能体审计日志。

## 8. 技能归档与摘要

新增共享包 `@huaanwork/skill-format`，供桌面 Host 与目录服务共同使用。归档格式为 `.tar.gz`，根目录必须含 `SKILL.md`，可包含脚本和其他资源。

```ts
export type SkillArchiveFile = { path: string; data: Buffer };

export type InspectedSkillArchive = {
  name: string;
  description: string;
  whenToUse?: string;
  files: SkillArchiveFile[];
  digest: string;
  skillMarkdown: string;
};

export function readSkillDirectory(root: string): SkillArchiveFile[];
export function createSkillDigest(files: readonly SkillArchiveFile[]): string;
export function buildSkillArchive(files: readonly SkillArchiveFile[]): Promise<Buffer>;
export function inspectSkillArchive(bundle: Buffer): Promise<InspectedSkillArchive>;
export function writeSkillDirectory(root: string, files: readonly SkillArchiveFile[]): Promise<void>;
```

统一预算：

- 压缩归档不超过 5 MiB。
- 文件内容总量不超过 5 MiB。
- 文件与目录总条目不超过 256。
- 单条规范化路径 UTF-8 不超过 512 字节。
- `SKILL.md` 正文沿用现有 64 KiB 上限，描述沿用 1024 字符上限。

安全规则：

- 只接受普通文件和目录；拒绝符号链接、硬链接、设备、FIFO、socket。
- 拒绝绝对路径、`..`、反斜杠、Windows drive prefix、重复路径和文件/目录冲突。
- 归档根必须直接包含 `SKILL.md`，其 frontmatter `name` 必须与 URL/本地技能名一致。
- 解压侧在 tar 前限制 gzip 输出并拒绝嵌套压缩魔数，不能仅限制压缩包大小。
- 摘要是按路径排序的文件 `path + size + sha256` 文档的 SHA-256，格式为 `sha256:<64 hex>`；服务端必须重算，客户端自报值不作为事实来源。
- 摘要提供完整性和幂等，不声称具备签名或审核保证。

## 9. 下载、上传与启用状态机

### 9.1 下载

1. 中心选择普通内置条目或共享精确 revision。
2. 内置条目直接从应用技能根读取；共享条目经同源、禁重定向、限时的 Host client 下载。
3. 完整校验归档、名称、摘要和预算。
4. 若本地无同名技能，原子写入 `<profileDir>/skills/<name>/`。
5. 写入 `origin`、`contentDigest`，保持用户启用键不存在，即默认禁用。
6. 本地存在同名同来源同摘要时幂等返回；存在更新时走显式更新；其他同名内容不得静默覆盖。

中心条目始终保留。下载失败不产生本地卡片，也不破坏已有本地副本。

### 9.2 启用与禁用

1. 我的技能点击启用后，Host 校验该名称确实存在用户技能。
2. 原子写用户启用状态，并刷新客户端可调用目录。
3. `/` 菜单只展示系统技能和 `enabled=true` 的本地技能。
4. Host 在每次显式调用时重新检查用户启用状态；未启用、已禁用或不存在的技能一律拒绝。显式 `/` 调用不检查 `userInvocable`；`user-invocable: false` 不阻止已启用本地技能被手动调用。
5. 禁用和删除立即影响之后发送的回合，不改写已经开始回合的历史内容。
6. 普通内置技能不再直接恢复为可调用项；系统技能继续由 guardrails 无条件注册。
7. 创建技能不写 `user-invocable`；导入技能保留原始 frontmatter；应用内编辑保留既有 `user-invocable` 行，但表单不再提供该字段，Host 也不把它作为手动调用门。

### 9.3 上传

1. Host 只接受本地用户技能名，不接受客户端传入任意文件路径。
2. 从用户技能根读取完整目录，重新计算摘要并构建归档。
3. 首次上传不带 expected revision；更新上传带**本地已记录的 `publishedRevision`** 作为 expectedRevision，不得先向服务器取最新值再原样送回——后者会盖掉他人刚发布的 revision，违背乐观并发。
4. 服务端验证上传者、owner、revision、归档和摘要后一次性发布。
5. 成功后本地记录 `publishedRevision`、`publishedDigest` 并刷新中心；本地文件与启用状态不变。
6. 响应丢失后使用相同内容重试，由最新 revision 同摘要规则保证幂等。

### 9.4 编辑、删除与中心变化

- 本地编辑保持原启用状态，更新 `contentDigest`；若曾发布则显示“有未上传修改”。
- 删除本地技能不删除中心记录，并清理本地来源与启用状态。
- 中心出现新 revision 不自动更新本地副本。
- 中心条目未来被删除或下架时，本地副本默认保留；远程撤销和强制禁用不在本规格范围。

## 10. 外部技能退出与运行防绕过

外部支持改为显式导入后，必须同时完成以下收敛：

1. `SkillSource` 删除 `external`，中心与本地列表均不扫描外部根。
2. `getSkill` 删除外部回退，显式 source 不再接受 `external`。
3. `resolveInvocableSkill` 对用户技能检查 `user-skill-toggles.json`，普通 bundled 不再作为非系统显式调用兜底。
4. standard、ptc、cordis preset 的嵌套 `skill-filesystem` 行统一把 `agentsHome` 指向 `<profileDir>/skill-provider-empty-agents-home`（由 Profile 准备阶段创建为空目录），从而保留项目和 bundled 根、只关闭 `$DSH_AGENTS_HOME/skills` 扫描；通过 HuaAnWork Profile override 实现，不改上游包。
5. 保留本地导入的文件/目录选择、预览、符号链接拒绝和校验能力。
6. 智能体包草稿与运行中的 `allowSkills` 共用 `resolveInvocableSkill`，因此未启用本地技能和外部技能同样不可被这些路径间接调用。

原外部文件保持原样。导入产生独立副本，后续原文件变化不自动同步。

本轮 preset 隔离只切断用户主目录 `$DSH_AGENTS_HOME/skills`（缺省 `~/.agents/skills`）的全局自动注入。项目工作区 `.dsh/skills`、`.agents/skills` 与 `$DSH_HOME/skills` 仍属上游 Provider 的既有扫描根，不在本轮外部标签移除范围内；若后续要控制这些根，须另行裁定。Profile 覆盖不得改变 ptc presentation 与 ConfigEditor 延迟落盘既有不变量。

## 11. 迁移与兼容

### 11.1 一次性本地迁移

以 `skill-local-state.json` 中 `migration.version === 1` 作为完成标记；迁移由 Host 在技能路由可用前执行。完成迁移后即使所有本地技能都禁用而没有任何启用键，也不得重跑迁移。

1. 对已有 `<profileDir>/skills/` 用户技能补来源和摘要；来源无法证明时标为 `created`。
2. 为保留旧版“用户技能始终可调用”的行为，迁移时把既有用户技能标为已启用。
3. 对旧 `skill-toggles.json` 中已启用的普通内置技能，复制为来源 `bundled` 的本地副本并设为已启用。
4. 若该内置名称已有本地副本，不覆盖本地文件；沿用显式调用原有的用户优先规则，把本地副本设为已启用并追加迁移警告。
5. 系统技能不复制；外部技能不自动导入。
6. 所有副本和状态写成功后才写完成标记。失败保留可重入临时状态并显示迁移警告，不能删除旧文件。

新建、导入和下载在迁移完成后默认未启用，与存量兼容策略不同是有意的升级保护。

### 11.2 旧设置与旧服务

- 旧 `skill-toggles.json` 只作为迁移输入，不再承载新用户启停。
- 旧智能体目录 API、审核和签名状态完全不变。
- 新技能上传 token 缺省为空；未配置时原有技能中心本地能力和智能体目录行为不受新上传接口影响。
- 服务端启动时若技能状态损坏必须拒绝技能服务并给出可诊断错误，不得静默清空。技能 store 与智能体 store 同在 `createAgentCatalogRuntime` 打开：技能状态损坏会使进程以退出码 1 结束，智能体目录一并不可用。这是共置启动的连带后果，属预期 fail-closed，不做技能单独降级。

## 12. 离线、失败与并发

- 中心目录读取与本地/可调用列表使用不同 Host 数据路径，远端失败不能拖垮我的技能或 `/`。
- 中心共享目录使用最近一次完整成功的缓存；不完整分页结果不得覆盖缓存。
- 内置下载可离线完成；共享下载和上传要求目录可达。
- 下载、上传、启停分别以来源和名称作为 busy key，禁止同技能重复并发操作，不阻塞无关技能。
- 更新上传使用 expected revision 防止两个客户端互相覆盖。
- 上传期间本地继续编辑时，发布的是读取时的快照；完成后若磁盘摘要不同则显示“有未上传修改”。
- 下载采用 staging + 原子 rename；更新已启用副本时保留启用状态，但必须由用户显式确认更新。
- 网络错误、权限错误、冲突和校验失败使用不同文案，不回显 token、Authorization 或未清洗的服务端响应正文。

## 13. 潜在影响

| 影响面 | 变化 |
| --- | --- |
| 数据展示 | 不再有跨源“全部”列表；搜索只在当前页；同名中心/本地副本不再被误判为同一状态 |
| 外部技能 | 升级后不再自动出现或调用，需要手动导入并启用；原文件不删除 |
| 内置技能 | 普通内置技能须下载后启用；系统技能仍始终可用 |
| 用户技能 | 从默认可调用改为受启用门控制；存量用户技能迁移为启用以保护升级体验 |
| 显式 `/` | 前端过滤不再是唯一门禁，Host 每次调用复检 |
| Agent preset | 外部文件技能扫描被关闭；已有依赖外部自动发现的流程需改为导入 |
| 智能体包 | `allowSkills` 继承同一启用门，相关 fixture 必须显式启用用户技能 |
| 网络与运维 | 新增技能 API、上传者 token、技能存储与审计；需要备份 `<dataDir>/skills/` |
| 安全 | 上传即发布扩大共享内容供给面，因此上传身份、归档预算、路径校验、审计和禁自动执行是必需项 |

## 14. 测试与验收

### 14.1 自动化覆盖

- 两标签、默认页、页内搜索、按钮可见性、来源徽标和空态。
- 用户技能启用/禁用、删除清理、重启恢复、手工 `/name` 拒绝未启用技能。
- 已启用本地技能即使含 `user-invocable: false` 仍可 `/` 调用；创建/编辑表单无“禁止用户手动调用”选项；编辑保留既有 `user-invocable` 行。
- 内置同名本地副本首次上传被拒绝；“另存为新技能”复制完整资源、生成新名称、默认未启用并可上传。
- 创建/导入/下载成功文案不得声称“新会话即可使用”；设置保存后技能中心刷新，启停/下载/删除后 `/` 目录刷新。
- 新共享包进入 workspace 布局、桌面内联打包、bundled runtime 与许可证门禁；服务端声明共享包依赖。
- `SkillDetail` 读模型与列表投影分离，Host `getSkill`、导入预览和写结果在最终 typecheck 中闭合。
- 外部技能在 UI、Host resolver 和三种 preset 中均不可自动调用；导入后默认禁用。
- 归档 round-trip、路径穿越、链接、嵌套压缩、超帽、重复条目、错误名称和摘要篡改。
- 服务端上传即发布、分页、精确 revision 下载、owner、expected revision、幂等、并发与审计恢复。
- 内置离线下载、共享下载原子性、本地同名冲突、更新和默认禁用。
- 上传权限隔离、首次发布、原作者更新、非 owner 冲突、响应丢失重试和上传期间编辑。
- 内网不可用时本地列表与 `/` 独立可用，缓存只由完整目录刷新。
- 迁移保留存量用户技能、旧内置启用态和同名本地内容，不自动导入外部技能。

### 14.2 真机端到端验收

1. 客户端 A 配置自己的技能上传口令，创建含脚本资源的技能并上传。
2. 客户端 A 和 B 都能在技能中心看到共享条目及 revision 1。
3. B 下载后在我的技能看到未启用副本，对话框 `/` 不展示且手工调用被 Host 拒绝。
4. B 启用后可通过 `/` 调用且资源目录正确；禁用后两条路径再次关闭。
5. A 修改并更新上传为 revision 2；B 看到更新但不自动替换本地副本。
6. B 使用不同上传者身份尝试更新 A 的名称，得到 `skill-name-conflict`，中心内容不变。
7. B 从外部目录导入技能，原文件保持不变；导入副本启用后才可调用。
8. 断开内网后，我的技能、启停和已启用 `/` 调用仍工作；中心共享部分展示缓存和明确警告。
9. 升级 fixture 验证既有用户技能、旧启用内置技能、同名冲突和外部文件处理。
10. macOS 与 Windows 均验证路径、归档、启停和下载；没有 Windows 主机时必须标为 BLOCKED，不得以 CI 或单元测试代替真机结论。

## 15. 完成定义

- 本规格目标全部实现，非目标未被夹带。
- 新增与变更测试先在旧实现上证明会失败，再在最终实现上通过。
- `corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check` 在最终代码树执行并记录退出码。
- 完成真实内网双客户端上传/下载/启停验收；不可执行项逐项标记 BLOCKED 和原因。
- 用户文档与部署文档同步说明两标签、本地导入、上传口令、上传即发布、外部技能变化和备份范围；`docs/skill-center.md/.en.md` 通过 `docs/skill-center.i18n.yaml` 纳入双语门禁，`docs/user-guide.*` 的历史未纳管范围须写明。
- 新共享包必须同步 root workspace 布局门禁、桌面 `devDependencies: "*"`、tsdown 内联、bundled runtime marker 与许可证第一方登记；服务端使用 `workspace:*` 依赖。
- 不修改上游子模块，不把本地单元测试结果写成跨机器或真机验收通过。
