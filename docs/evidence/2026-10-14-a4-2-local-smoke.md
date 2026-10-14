# A4-2 本机联通验证记录(2026-10-14)

范围:P1(call_host_tool 注册,d67dc09958)修复后,按「本机即公用机」方式完成
目录下发 → 启用 → @点名 → call_host_tool → 服务应答 的端到端冒烟。

## 环境

- 公用机 = 本机,LAN IP `192.168.3.109`;四服务后台启动(日志 `/Users/Shared/huaanwork-logs/`):

| 服务 | 端口 | 启动方式 | 状态 |
| --- | --- | --- | --- |
| agent-catalog-server | 18080 | `node bin.mjs`,HOST=LAN IP | ✅ `/v1/catalog` 带口令 200、无口令 401 |
| typo-check | 18081 | `.venv/bin/python -m api`,`TYPOGUARD_ALLOWED_ROOT=/Users/Shared/huaanwork-docs` | ✅ 带口令 `status` 返回业务错误「作业不存在或已过期」(鉴权与作业存储正常) |
| code-review | 18082 | `PORT=18082 node server.mjs`(代码默认 8765,须覆盖) | ✅ 带口令应答;错误 action 正常报错 |
| task-orch | 8787 | `node dist/index.js --config tasks.json --db orch.db --port 8787 --host <LAN_IP>` | ✅ `/health` ok;`/agent-invoke` list 返回 4 个示例任务 |

- 统一口令:四服务共用桌面端已存的 `agents_catalog_token`(19 字符),与
  `agent-tool.ts:185-190` / `agents-host.ts:273` 的 Bearer 语义一致。
- 条目修复:三个 `entries/*.json` 的 `http://<LAN_IP>:…` 占位符替换为
  `192.168.3.109`(替换前桌面端 LAN 校验必拒)。
- task-orch 前置:`cp examples/tasks.json tasks.json`;示例任务 `push-notify`
  需 `DEMO_API_TOKEN`(本次用占位值 `demo-smoke-local`,仅冒烟)。

## 桌面端动作

- 设置写入 `~/.huaanwork/profiles/desktop/huaanwork-settings.json`:
  `agents_host=192.168.3.109`、`agents_port=18080`(口令此前已存)。
- 应用经 `node lib/bin.js` 启动(lib 构建 18:37 晚于 P1 修复提交 18:08,含修复)。
  注:`corepack yarn dev` 被 `market:prepare` 阻断(dshmarket 1.66.21 patch
  hunk #2 打不上,既有问题,与本次无关)。
- `POST /huaanwork/agent/refresh` → 200,目录三条目全到;
  `agent.setEnabled` ×3(confirmPermissions:true)→ 全部 `ok:true`。
- 「智能体」页截图:三条目卡片显示「公用机 v0.1.0/v1.0.0」,状态「已启用」。

## 聊天链(@ 点名端到端)

1. 输入框键入 `@` → 补全菜单列出 @code-review / @task-orch / @typo-check(含描述)。
2. 发送 `@task-orch 列出所有任务` → 模型回 "I'll list the scheduled tasks…" 并发起
   **批准请求 · call_host_tool「调用公用机小工具 task-orch」**(批准/拒绝按钮正常)。
3. 批准后模型拿到 `/agent-invoke` 真实应答,输出 4 个任务(sync-data/push-notify/
   heartbeat/bad-task)的中文明细表,含调度、时区、认证方式等细节。
   ⇒ P1 修复后的聊天链**贯通**,A4-1 §三 复测清单核心项通过。

## 常驻化(同日追加)

四个服务已按 runbook §3 装为**用户级 LaunchAgents**(sudo 需要密码,系统级
LaunchDaemons 未用;runbook 允许用户级,代价是仅当前用户登录期间运行):

- `~/Library/LaunchAgents/cn.huaanwork.{agent-catalog-server,typo-check,code-review,task-orch}.plist`,
  `chmod 600`(含口令);`launchctl bootstrap gui/<uid>` 载入,KeepAlive + ThrottleInterval 10。
- 占位符实值:DEPLOY_ROOT=`/Users/amonmiao/Downloads/cursor`、NODE_BIN=`/opt/homebrew/bin/node`
  (22.23.2,免 `--experimental-sqlite`)、LAN_IP=`192.168.3.109`、
  SHARED_DOCS=`/Users/Shared/huaanwork-docs`;`DASHBOARD_TOKEN` 新生成(已告知用户);
  `WEBHOOK_URL` 未设(tasks.json 的 `global.webhook_url` 生效)。
- 临时后台进程全部停止、`lsof` 确认端口释放后才 bootstrap;载入后四服务
  `state = running`,带口令冒烟:catalog 三条目、typo/code-review 业务错误正常、
  task-orch `health` ok。
- 卸载:`launchctl bootout gui/<uid>/cn.huaanwork.<name>`;日志在
  `/Users/Shared/huaanwork-logs/`。

## 遗留/注意

- ~~四服务与本应用均为本次会话的后台进程,**会话结束即停**~~(已常驻化,见上节);
  HuaAnWork 桌面应用本身仍是手动启动,不在常驻范围(桌面应用按需开)。
- task-orch 的 tasks.json 是 examples 拷贝,示例端点 `127.0.0.1:9100` 不存在,
  调度引擎会持续产生失败告警(仅演示数据)。
- 错别字车道未做真实 docx 端到端(共享目录 `/Users/Shared/huaanwork-docs` 为空,
  服务层冒烟已到「作业不存在」业务错误为止)。
- typo 服务对 `{"action":...}` 平铺体偶发响应异常(`HTTP 000`),信封
  `{"arguments":{...}}` 形态正常——call_host_tool 恒用信封形态,不受影响,
  但值得记一笔。
