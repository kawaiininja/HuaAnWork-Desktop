# 智能体服务运维手册(launchd 常驻)

> 适用范围:本机(192.168.3.109)同时作为「公用机」运行四个智能体服务,
> HuaAnWork 桌面端经「智能体」页接入。安装与联调证据见
> `docs/evidence/2026-10-14-a4-2-local-smoke.md`。
>
> ⚠️ 口令不落本文档。`DASHBOARD_TOKEN` 与目录口令的存放位置见下表。

## 1. 架构一览

```
HuaAnWork 桌面端(对话框 @点名)
   │  ① GET /v1/catalog(Bearer 口令)拉目录
   ▼
agent-catalog-server :18080 ── entries/*.json(typo-check / code-review / task-orch)
   │
   │  ② 用户 @点名 → call_host_tool(POST entrypoint.url,Bearer 同一口令)
   ▼
┌─────────────────────┬─────────────────────┬─────────────────────┐
│ typo-check :18081   │ code-review :18082  │ task-orch :8787     │
│ docx 错别字检测      │ 目录代码审查         │ 定时任务编排/监控    │
│ submit/status/result│ submit/status/result│ run/list/runs/...   │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

## 2. 安装结果(2026-10-14)

| 服务 | launchd Label | 端口 | 工作目录 | 状态 |
| --- | --- | --- | --- | --- |
| 目录服务 | `cn.huaanwork.agent-catalog-server` | 18080 | `/Users/amonmiao/Downloads/cursor/agent-catalog-server` | running |
| 错别字检测 | `cn.huaanwork.typo-check` | 18081 | `/Users/amonmiao/Downloads/cursor/错别字检测智能体` | running |
| 代码审查 | `cn.huaanwork.code-review` | 18082 | `/Users/amonmiao/Downloads/cursor/代码审查智能体` | running |
| 任务编排 | `cn.huaanwork.task-orch` | 8787 | `/Users/amonmiao/Downloads/cursor/任务编排智能体` | running |

- 安装形态:**用户级 LaunchAgents**(`~/Library/LaunchAgents/cn.huaanwork.*.plist`,
  均 `chmod 600` 因含口令),`KeepAlive` + 10s 节流,登录后自启、崩溃自动拉起。
  **仅当前用户(amonmiao)登录期间运行**。
- 日志目录:`/Users/Shared/huaanwork-logs/`(每服务一个 .log,stdout/stderr 同文件)。
- Node:`/opt/homebrew/bin/node`(22.23.2,task-orch 免 `--experimental-sqlite`)。

## 3. 两个关键值

| 值 | 内容 | 用途 |
| --- | --- | --- |
| **看板口令 DASHBOARD_TOKEN** | 见 `~/Library/LaunchAgents/cn.huaanwork.task-orch.plist`(600 权限) | task-orch Web 看板 `http://192.168.3.109:8787` 的 Bearer 访问口令,与目录口令互不相干 |
| **共享文档目录** | `/Users/Shared/huaanwork-docs` | `@typo-check` 的 `TYPOGUARD_ALLOWED_ROOT`——只有放进此目录的 .docx 才会被受理 |

> 目录口令(`AGENT_CATALOG_TOKEN`,四服务共用)不落本文档;存在桌面端设置
> `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 与四个 plist 中。
> 更换口令须同时改:四个 plist + 桌面端「智能体」页口令,然后重启四服务。

## 4. 常用运维命令

```bash
# 查状态(state / pid / 最近退出码)
launchctl print gui/$(id -u)/cn.huaanwork.<服务名>

# 重启(改配置/条目后)
launchctl kickstart -k gui/$(id -u)/cn.huaanwork.<服务名>

# 卸载 / 重新载入
launchctl bootout gui/$(id -u)/cn.huaanwork.<服务名>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/cn.huaanwork.<服务名>.plist

# 看日志
tail -f /Users/Shared/huaanwork-logs/<服务名>.log

# 健康冒烟(口令从桌面端设置读取)
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.huaanwork/profiles/desktop/huaanwork-settings.json'))['agents_catalog_token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.3.109:18080/v1/catalog      # 目录三条目
curl -s http://192.168.3.109:8787/health                                            # task-orch {"status":"ok"}
```

服务名:`agent-catalog-server` / `typo-check` / `code-review` / `task-orch`。

## 5. 常见运维场景

### 5.1 新增/修改智能体条目

直接编辑 `/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries/*.json`,
**改文件即生效**(目录服务每次请求实时重读,无需重启);桌面端最迟 60s 后可见
(客户端目录缓存 TTL),或在「智能体」页点「刷新」。
注意:条目 `entrypoint.url` 必须是真实内网地址,`<LAN_IP>` 这类占位符会被桌面端拒绝。

### 5.2 服务起不来

1. `launchctl print gui/$(id -u)/cn.huaanwork.<服务名>` 看 `last exit code`;
2. 看 `/Users/Shared/huaanwork-logs/<服务名>.log` 尾部;
3. 常见原因:端口被占(`lsof -nP -iTCP:<端口> -sTCP:LISTEN`)、口令环境变量缺失
   (四服务缺 `AGENT_CATALOG_TOKEN` 均拒绝启动)、task-orch 的 `tasks.json`
   引用了未设置的密钥环境变量(如 `DEMO_API_TOKEN`)。

### 5.3 错别字检测提交文档被拒

确认 docx 的**绝对路径解析后位于 `/Users/Shared/huaanwork-docs` 之内**;
越界/不存在/非 .docx 一律拒绝(设计内行为)。

### 5.4 升级为系统级常驻(所有用户可用)

需 sudo:

```bash
sudo cp ~/Library/LaunchAgents/cn.huaanwork.*.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/cn.huaanwork.*.plist
sudo chmod 600 /Library/LaunchDaemons/cn.huaanwork.*.plist
for s in agent-catalog-server typo-check code-review task-orch; do
  launchctl bootout gui/$(id -u)/cn.huaanwork.$s
  sudo launchctl bootstrap system /Library/LaunchDaemons/cn.huaanwork.$s.plist
done
```

注意:系统级以 root 运行,工作目录与 `.env`/`.venv` 的读取权限需另行确认。

## 6. 已知遗留项

- task-orch 的 `tasks.json` 目前是 examples 拷贝,示例端点 `127.0.0.1:9100`
  不存在,调度器会持续产生失败告警(仅演示数据);正式任务请改写该文件后
  `kickstart -k` 重启 task-orch。
- `DEMO_API_TOKEN=demo-smoke-local` 是占位值,仅供示例任务 `push-notify` 加载。
- HuaAnWork 桌面应用本体不在常驻范围,按需手动启动;设置已配好
  (`agents_host=192.168.3.109` / `agents_port=18080`),打开即可 `@` 三个智能体。
- 完整部署模板(launchd 系统级 + systemd)见
  `/Users/amonmiao/Downloads/cursor/agent-catalog-server/docs/deployment-runbook.md`。
