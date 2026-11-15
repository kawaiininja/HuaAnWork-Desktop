# 内网技能中心部署与运维

本文说明如何在组织内网部署共享技能目录（技能中心），以及桌面客户端如何连接、发布和备份。技能目录由现有的 `agent-catalog-server` 进程提供：它与智能体目录共用地址、端口、read token 和审计基础设施，但使用独立的存储、独立的技能上传 token 和独立的 `/v1/skills` API。

## 1. 服务端配置

技能上传使用独立的 `AGENT_CATALOG_SKILL_UPLOADERS`，**不得**复用智能体包的 publish token：

```bash
# 运维先生成每个上传者的口令（示例；不要提交真实 token）
openssl rand -hex 32   # alice 的技能上传口令
openssl rand -hex 32   # bob 的技能上传口令

AGENT_CATALOG_SKILL_UPLOADERS="{\"alice\":\"${ALICE_SKILL_TOKEN}\",\"bob\":\"${BOB_SKILL_TOKEN}\"}"
```

约束（启动时 fail-closed 校验）：

- 发布者 id 必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`。
- 每个 token 至少 32 字符，彼此不同，且不得与 read / publish / admin token 重复。
- 未配置该变量时技能上传被禁用，但浏览、下载、本地技能与 `/` 调用不受影响。
- 校验失败时进程拒绝启动；错误信息不会回显 token 内容。

浏览与下载复用现有的 `AGENT_CATALOG_TOKEN`（read token）。技能路由与智能体路由互不授予对方权限：技能上传 token 不能提交或审批智能体包，智能体 publish token 也不能发布技能。

## 2. 客户端设置

桌面端在 **设置 → 质检 → 公用机配置** 中填写：

- 公用机地址 / 端口：与智能体目录相同。
- 访问口令：read token。
- 技能上传口令：该用户自己的技能上传 token（留空则只禁用上传）。

设置每次请求都会重新读取，保存后无需重启 Host。客户端会拒绝公网地址与跨源重定向。

## 3. API 摘要

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/v1/skills?cursor=&limit=` | read：列出每个名称的最新 revision（limit 默认 100，范围 1–100） |
| GET | `/v1/skills/{name}/{revision}` | read：精确 revision 元数据 |
| GET | `/v1/skills/{name}/{revision}/archive` | read：精确 revision 的 `.tar.gz` |
| POST | `/v1/skills/{name}` | skill-publish：上传即发布 |

上传是原始 `application/gzip` 归档，压缩后与解压内容各不超过 5 MiB，条目不超过 256、路径不超过 512 UTF-8 字节。服务端校验归档结构、名称与摘要后立即发布，**没有审核队列、没有签名和 keyring 校验**；摘要只保证完整性，不构成发布者身份背书。首次发布同一名称同一摘要的重试是幂等的；更新必须携带 `X-Skill-Expected-Revision`，非 owner 更新返回 `skill-name-conflict`。

## 4. 存储、备份与恢复

技能状态独立于智能体目录：

- `<dataDir>/skills/state.json`：revision、owner、发布者与归档路径。
- `<dataDir>/skills/archives/<name>/<revision>.tar.gz`：不可变的归档副本。
- `<dataDir>/skills/audit.jsonl` 与 `audit-intents.jsonl`：技能专属审计。

**备份整个 `<dataDir>/skills/` 目录**（含归档与审计），并与 `<dataDir>/state.json` 分开保管。恢复时整体还原；不要只还原 `state.json` 而遗漏归档。

状态文件损坏时服务端拒绝启动（退出码 1），不会静默清空为“空目录”。技能状态与智能体目录共用一个进程：技能状态损坏会连带智能体目录不可用，这是共享启动路径的预期 fail-closed 后果，不做单独降级。

## 5. 口令轮换

1. 生成新 token 并更新 `AGENT_CATALOG_SKILL_UPLOADERS`（保留旧条目直到所有使用者完成切换，或直接替换以强制轮换）。
2. 重启 `agent-catalog-server`。
3. 通知使用者更新桌面端的“技能上传口令”。旧 token 立即失效，已发布内容不受影响。

## 6. 已知边界

- 目录是内网快照共享，不是公共市场，也不删除本地副本：中心条目消失或下架时，本机技能默认保留。
- 下载与上传都是复制；上传不改变本地启用状态，下载的副本默认未启用。
- 桌面端只隔离全局 `$DSH_AGENTS_HOME/skills`（缺省 `~/.agents/skills`）的自动扫描；项目工作区 `.dsh/skills`、`.agents/skills` 与 `$DSH_HOME/skills` 仍属上游 Provider 的既有扫描根。
