# A4-1 桌面端 GUI「添加入口」联调测试指引(人工)

- **日期**:2026-10-14
- **范围**:实施计划 M-A4 的 Task A4-1——在 HuaAnWork 桌面端「智能体」面板以**本地入口**登记三个服务,`@点名` 走通全链。机器可执行部分(契约探活/全链/解析器校验)已完成,见 `docs/evidence/2026-10-14-agents-catalog-integration-precheck.md`;本指引只覆盖 GUI 与真模型回路。
- **执行人**:人工(约 30–40 分钟;typo-check 真车道选做项另加 5 分钟,不需要等作业完成)。

---

## 0. 前置准备

### 0.1 起服务(开发机,127.0.0.1)

工作区与总控脚本沿用预联调归档(`docs/evidence/assets/a4-precheck-2026-10-14/supervisor.sh`),先备工作区再起服:

```bash
W=/tmp/a4-precheck
mkdir -p $W/entries $W/shared $W/typo-jobs $W/crw-jobs $W/fixture/subA
# 条目(本地联调不直接消费,但保留同形环境)
for n in typo-check code-review task-orch; do
  sed 's/<LAN_IP>/127.0.0.1/' \
    /Users/amonmiao/Downloads/cursor/agent-catalog-server/entries/$n.json > $W/entries/$n.json
done
printf 'PK\x03\x04 fake docx placeholder' > $W/shared/季度报告.docx
echo 'console.log("smoke");' > $W/fixture/subA/a.js
sh /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/assets/a4-precheck-2026-10-14/supervisor.sh
```

另开一个终端确认五口全起(18080/18081/18082/8787/9100)。服务口令为 `precheck-2026-10-14`(写在 supervisor.sh 里)。**保持 supervisor 终端不关**。

> typo-check 此模式带 `TYPOGUARD_FAKE_RUNNER=1`(秒回假报告,联调节奏用);真车道见 §3.2。

### 0.2 起桌面端

```bash
corepack yarn workspace dsh-plugin-huaanwork start   # lib 最新时;源码有改动用 dev
```

细节与排障见 `docs/huaanwork-dev-launch.md`。需要已配置可用的对话模型(本变体既有前置,不在本指引范围)。

### 0.3 面板设置:**只填口令,公用机地址/端口必须留空**

侧边栏「智能体」→ 顶部配置区:

| 字段 | 填写 |
| --- | --- |
| 公用机地址 | **留空** |
| 端口 | **留空** |
| 口令 | `precheck-2026-10-14`(与 supervisor.sh 的 `AGENT_CATALOG_TOKEN` 一致) |

保存。**为什么必须留空**:`call_host_tool` 对本地入口也统一带该口令,所以口令必须配;但一旦填了地址/端口,目录服务(18080)可达,同名目录条目下发后**本地入口会被标记「重名条目」而损坏**,@点名随之失效(桌面端 `getMergedItems` 的重名逻辑)。目录路径留给 A4-2 验证。

> 若想在 A4-1 顺手预览目录效果,务必另建**不同名**的试验条目,勿与本轮三个名字冲突。

---

## 1. 登记三个本地入口

「智能体」面板 →「**本地入口**」页签 →「**＋ 添加入口**」,逐个登记(名称必须与下表完全一致——@点名与 `^[a-z0-9-]+$` 依赖它):

| 字段 | code-review | typo-check | task-orch |
| --- | --- | --- | --- |
| 名称 | `code-review` | `typo-check` | `task-orch` |
| 类型 | 小工具(锁定) | 同左 | 同左 |
| 入口类型 | HTTP | HTTP | HTTP |
| 地址 | `http://127.0.0.1:18082/invoke` | `http://127.0.0.1:18081/invoke` | `http://127.0.0.1:8787/agent-invoke` |
| 描述(选填,建议填) | 审查目录源码,异步 submit→status→result | 检测 docx 错别字,异步 submit→status→result | 定时任务编排:触发/查询/暂停恢复 |
| 参数 schema(选填,建议填) | 从 `agent-catalog-server/entries/code-review.json` 复制 `argumentsSchema` 整对象粘贴 | 同左,取 `typo-check.json` | 同左,取 `task-orch.json` |

预期:添加后「本地入口」页签列出三条,徽标「本地入口 / 端口」,无损坏标记;聊天输入框敲 `@` 出现自动补全并能看到三者。

## 2. code-review 全链(GUI)

聊天框**整条消息以下列开头**(@点名解析要求消息以 `@name` 起始):

```
@code-review 审查 /tmp/a4-precheck/fixture,子文件夹 subA
```

- **预期弹窗**:每次模型调 `call_host_tool` 前出现确认提示「调用公用机小工具「code-review」」——允许即可。这是设计内行为,每个 action 都会出现。
- **预期回复**:模型转述 submit 结果,含 `jobId`(`jr_` + 12 位)与「已排队」;随后问进度:
  ```
  @code-review 查一下刚才那个作业的状态
  ```
  预期 running 时附「已产出 N/1 份报告」进度;完成后取报告:
  ```
  @code-review 把刚才的审查报告给我
  ```
  预期报告正文(mock 报告约几百字符,`hasMore=false`;>20KiB 的续拉已由分页测试与 smoke 覆盖,GUI 段如实记录即可)。
- **部分失败诚实化目验**(可选,强烈建议):发
  ```
  @code-review 审查 /tmp/a4-precheck/fixture,子文件夹 subA 和 ghostZ
  ```
  预期取回的报告**以「注意:1 个子文件夹审查失败:ghostZ」开头**——这是 F5 修复的落地形态。

## 3. typo-check 全链

### 3.1 快速链(fake runner,必做)

```
@typo-check 检查 /tmp/a4-precheck/shared/季度报告.docx
```

预期:submit 秒回,`estimatedMinutes:40` 字样被模型转述(「预计 40 分钟」);等 1–2 秒后查状态已 done,取报告为「冒烟报告/假 runner 产出」。

### 3.2 真车道(选做,5 分钟,不需要等完成)

1. 停掉 supervisor(Ctrl-C),注释掉 supervisor.sh 里 typo 那行的 `TYPOGUARD_FAKE_RUNNER=1 ` 再起(或手工单独起 typo 服务);前提:仓内 `.env` 已配 `TYPOGUARD_LLM_API_KEY` 与 verifier 三件套(异厂商),否则启动即 `StartupError`(config.py 校验)。
2. 在共享目录放一份**真实 docx**,发 `@typo-check 检查 <共享目录>/<真实文档>.docx`。
3. 只验证两点:**submit 秒回 jobId**;一分钟后查 status,预期 state=running 且 progress 含「已扫描 N/M 块、预计剩余约 X 分钟」(真实管线 17–75 分钟,**不必等完成**;完成后可另行取报告)。
4. 验完切回 fake 模式(便于后续重复联调)。

## 4. task-orch 八 action

依次发送(每次预期出现调用确认弹窗):

| 发送 | 预期模型转述 |
| --- | --- |
| `@task-orch 看下有哪些定时任务` | 任务列表(examples 四任务:sync-data/push-notify/heartbeat/bad-task) |
| `@task-orch 手动触发 sync-data` | 「已触发」+ 建议稍后用 runs/show 查(触发即回,execId 可不抄) |
| `@task-orch 查最近几条执行记录` | runs 列表(含刚才的 manual 记录) |
| `@task-orch 暂停 heartbeat 调度` | 已暂停 |
| `@task-orch 恢复 heartbeat 调度` | 已恢复 |
| `@task-orch 查最近告警` | alerts(有 bad-task 的 critical 记录;推送状态 failed 属预期——WEBHOOK_URL 未配) |
| `@task-orch 触发一个不存在的任务 xyz` | 「任务不存在:xyz」 |
| `@task-orch 健康检查` | ok |

**重点目验**:手动触发后模型应当**立即**答复(触发即回,设计 R2-1)——若模型回复明显等了几秒以上,记录现象(可能是模型侧自行等待,非服务问题;可对照 `runs` 里该记录的 started/finished 时间)。

## 5. 面板行为与错误路径

1. **启停**:「已启用」页签(或列表开关)禁用任一入口 → `@` 补全不再出现该名字、点名返回「未启用或不存在」;重新启用恢复。
2. **错口令**:面板口令改成任意错误值保存 → 任一服务 @调用 → 预期模型转述 401/「口令错误」类失败(桌面端报 `HTTP 401: {"error":"口令错误"}` 的前 500 字符);改回正确口令恢复。
3. **删除**:删除任一本地入口 → 列表消失、@点名失效;重新添加可恢复。

## 6. 记录与收尾

- **证据归档**:截图(登记表单、三入口列表、每服务对话各一轮、错误路径、启停)+ 关键对话文本,放 `docs/evidence/assets/a4-1-gui-2026-10-14/`,并在 `docs/evidence/` 下补一页记录(格式参照预联调记录)。
- **收尾**:删除三个本地入口(或保留供回归;A4-2 切目录时**必须删**,避免与目录条目重名);停服务(supervisor 终端 Ctrl-C;残留口检查 `lsof -i :18080 -i :18081 -i :18082 -i :8787 -i :9100`)。
- **A4-2 衔接**:按 `agent-catalog-server/docs/deployment-runbook.md` 在公用机部署后,先删本地入口、再配面板公用机地址/端口/口令;注意目录缓存 60s TTL,「发现」页不见先点刷新;条目 `<LAN_IP>` 替换为真实内网 IP 是**承重步骤**(预联调实测:不替换必 broken)。

## 7. 常见偏差速查

| 现象 | 大概率原因 |
| --- | --- |
| 模型不调工具、开始自行探索 | 消息不是以 `@name` 开头,或模型未按信封指引;重发一条干净的 `@name …` 消息 |
| 调用报「未挂载或不存在的小工具」 | 入口名与 @名不一致;或入口被禁用/标记重名损坏(检查是否误填了公用机地址) |
| 每个调用都 401 | 面板口令与服务 `AGENT_CATALOG_TOKEN` 不一致(supervisor.sh 内为 `precheck-2026-10-14`) |
| 本地入口带「重名条目」标记 | 面板填了公用机地址/端口且目录内有同名条目——清空地址/端口即可恢复 |
| 「发现」页目录条目迟迟不出现(A4-2) | 60s 目录缓存 TTL,点刷新;仍无则查 catalogError 提示 |
| typo-check 真车道服务起不来 | `.env` 缺 LLM key 或 verifier 与 A/B 同厂商(config.py 启动校验);`TYPOGUARD_VERIFIER_MOCK=true` 可降级 |

—— A4-1 指引完 ——
