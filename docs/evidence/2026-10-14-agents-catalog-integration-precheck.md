# M-A4 预联调记录(机器可执行部分)— 2026-10-14

- **范围**:M-A4 中可由 CLI 侧完成的部分——五进程同机起服(四服务 + mock-api)、runbook §8 探活、三智能体全链契约走查、真解析器条目校验。**A4-1 的 GUI 面板/真机 @点名与 A4-2 的公用机切目录为人工步骤,未包含**(清单见文末)。
- **方法**:全部请求体以 JSON 用例文件落盘(`docs/evidence/assets/a4-precheck-2026-10-14/`,13 个预置 + 6 个 jobId 动态生成,连同总控脚本 `supervisor.sh` 与解析器校验脚本 `validate-entries.mts` 共 20 件;运行期原件在 `/tmp`,已归档进仓),`curl -d @file` 注入,规避 shell 转义;服务由单总控脚本托管(五进程,127.0.0.1:18080/18081/18082/8787/9100)。
- **环境**:开发机 macOS,Node v22.23.2,typo-check 用 `.venv` + `TYPOGUARD_FAKE_RUNNER=1`(CI 桩),code-review 用 `CODE_REVIEW_MOCK=1`,task-orch 用 `examples/tasks.json` + `test/mock-api.mjs`(9100)+ `DEMO_API_TOKEN=dummy-token`,口令 `precheck-2026-10-14`。
- **条目**:`<LAN_IP>` 以 sed 替换为 `127.0.0.1` 生成本地副本(`/tmp/a4-precheck/entries/`),仓内条目文件未改动。

## ① runbook §8 探活(五项全对)

| 探针 | 预期 | 实测 |
| --- | --- | --- |
| `GET /v1/catalog` 带口令 | 200 | 200 |
| `POST /invoke` 无口令(typo/crw) | 401 | 401 / 401 |
| `GET /health`(orch) | 200 | 200 |
| `POST /agent-invoke` 无口令(orch) | 401 | 401 |

## ② 目录下发

`GET /v1/catalog` → `items: code-review@v1.0.0, task-orch@v0.1.0, typo-check@v0.1.0`;`GET /v1/catalog/task-orch` → 单条目 JSON,`entrypoint.url=http://127.0.0.1:8787/agent-invoke`。

## ③ typo-check 全链(fake runner)

- `submit`(共享目录内 docx)→ `{jobId:"jr_soSKTELrBGgL", state:"queued", estimatedMinutes:40}`(S-2 的 estimatedMinutes 落地可见)
- `status` → `{state:"done", elapsedSeconds:1}`(S-2 的 elapsedSeconds 落地可见,原始时间戳不再外露)
- `result` → `{text:"# 冒烟报告…", offset:0, nextOffset:29, totalChars:29, hasMore:false}`

## ④ code-review 全链(mock)

- `submit`(root + `include:"subA,ghostZ"`)→ `{jobId:"jr_uA99LehKkQUP", state:"queued"}`(秒回)
- `status` → `{state:"done", elapsedSeconds:1}`(作业模式不受平台 150s 约束)
- `result` 首片 → `text` 以 **`注意:1 个子文件夹审查失败:ghostZ`** 开头(F5 部分失败诚实化落地可见),随后为 subA 的 mock 报告全文

## ⑤ task-orch 十二用例(`POST /agent-invoke`)

| 用例 | 结果 |
| --- | --- |
| `health` | `{"ok":true,"result":{"status":"ok"}}` |
| `list` | 4 个 examples 任务(sync-data/push-notify/heartbeat/bad-task) |
| `run sync-data` | `{outcome:"triggered", execId, note:"已触发,用 runs/show 查结果"}` |
| `run`(1s 内重复) | `{ok:false, error:"触发过于频繁(1s 防抖),请稍后"}` |
| `runs limit=3` | 执行记录数组(manual 触发的 success 记录在列) |
| `show <execId>` | 执行详情命中 |
| `pause`/`resume heartbeat` | `enabled:false` → `true`,翻转成功 |
| `alerts limit=2` | 告警数组(bad-task 的 critical 告警在列;WEBHOOK_URL 未配,记录为 failed 状态——符合设计) |
| `run no-such-task` | `{ok:false, error:"任务不存在:no-such-task"}` |
| 未知 action | `{ok:false, error:"未知 action:bogus,支持 run/list/runs/show/pause/resume/alerts/health"}` |
| **坏 JSON**(S-1 回归) | `{ok:false, error:"请求体不是合法 JSON"}`(200,不再 500) |
| **缺 arguments**(S-1 回归) | `{ok:false, error:"请求体缺少 arguments 对象"}`(200) |

## ⑥ 真解析器条目校验(`parseCatalogItem`,经 tsx 加载桌面端真源码)

| 条目组 | 结果 |
| --- | --- |
| 本地 127.0.0.1 副本 | **三条目全部 OK**(typo-check@v0.1.0 / code-review@v1.0.0 / task-orch@v0.1.0,entrypoint 与端口正确)——**A0-4 Step 2 的「人肉核对」就此由真解析器闭合** |
| 仓内 `<LAN_IP>` 占位版 | **三条目全部 BROKEN:「entrypoint.url 不是合法 URL」**——证实 runbook §7 的部署期替换步骤是**承重的**:不替换则「发现」页直接呈现损坏态 |

## 观察与运维备注(已同步 runbook)

1. **Node 22.13+ 无需 `--experimental-sqlite`**(本机 22.23.2 实测直接 import 成功;首启打印的 M2 预检警告为保守口径,可忽略)。runbook §1/§3.4/§4.4 已按版本边界订正:flag 硬要求仅适用 Node 22.5–22.12。
2. **`examples/tasks.json` 的 `${DEMO_API_TOKEN}`**:未设置该环境变量时 task-orch 启动即失败(「密钥引用解析失败:密钥环境变量未设置」)——已补进 runbook §1 task-orch 前置。
3. 首轮用 shell 内联转义拼 JSON 时出现过一次自伤性坏请求,恰好实测了 S-1 的两条错误路径——错误处理真实生效,非仅测试内断言。

## 遗留给人工的 M-A4 步骤(A4-1 GUI / A4-2 公用机)

1. **A4-1(开发机或 LAN)**:桌面端「智能体」面板「＋ 添加入口」逐个登记三个服务(schema 从 `agent-catalog-server/entries/*.json` 复制,URL 换成可达地址),聊天框 `@typo-check` / `@code-review` / `@task-orch` 各跑一次真实任务(错别字用真 docx 走真车道,需 `.env` 密钥;code-review 用一个小仓库);确认 submit 秒回 jobId、status 有 progress、result 分页续拉完整;错口令确认 401 中文文案;启停/删除入口正常。
2. **A4-2(公用机)**:按 `agent-catalog-server/docs/deployment-runbook.md` 部署四服务 → §8 探活 → 把仓内条目的 `<LAN_IP>` 替换为公用机内网 IP(**本记录 ⑥ 已证明不替换必 broken**)→ 条目放 `entries/` → 面板配置公用机地址/口令 → 「发现」页启用 → 删本地入口重跑等价性验证 → 验收记录(截图 + 请求样例)归档本目录。
3. typo-check 公用机真车道质检前提(runbook §4.2/评审 §10.6 已登记):`TYPOGUARD_LLM_API_KEY` + verifier 三件套(异厂商)或 `TYPOGUARD_VERIFIER_MOCK=true` 降级。

—— M-A4 预联调完(2026-10-14;五服务已全部停止,端口已清)——
