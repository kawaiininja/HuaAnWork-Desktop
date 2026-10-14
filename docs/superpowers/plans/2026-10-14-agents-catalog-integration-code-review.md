# 三智能体接入实施 — 代码评审结论(四仓)

- **评审对象**:`plans/2026-10-14-agents-catalog-integration.md`(最终通过版)的 M-A0~M-A3 代码实现
  - `agent-catalog-server` @ `d405fe8`(9 commits,全新仓)
  - `代码审查智能体` @ `d6fd300`(基线 `68ada9d~1`,8 commits)
  - `错别字检测智能体` @ `baa929b`(8 commits,`api/` 包 + 测试)
  - `任务编排智能体` @ `85283d3`(基线 `29c396c`,6 commits)
- **评审日期**:2026-10-14
- **评审范围**:M-A0~M-A3 代码与测试;**M-A4(联调/真机验收)未执行,不在本轮范围**
- **评审链定位**:设计两轮 + 实施计划两轮半的评审记录见 `specs/2026-10-13-agents-catalog-integration-review.md`(§一~§十);本文是实施后的代码评审结论,即评审链收口件
- **结论**:~~通过——无 critical;3 项警告级遗留(均 code-review 仓,均为小修),修复 + 回归后进入 M-A4;5 项建议级随 A4 消化或登记为已知差异~~ → **2026-10-14 处置完成(§六):8/8 发现全部修复,全量回归 308/308 通过,两条 smoke PASS——A4 前置清空,可进入 M-A4 联调**

---

## 一、评审方法(四轮验证,全部实跑)

1. **静态审查**:逐文件通读四仓全部新增/改写代码(M-A0 四文件 + 三个条目、M-A1 的 server/job-store/paginate/auth、M-A2 的 api/ 七文件、M-A3 的 agent-invoke.ts + scheduler/server/index 改动)。
2. **测试实证**:四仓测试套件全量实跑(结果见 §二)。
3. **端到端冒烟**:code-review 与 typo-check 的 `smoke_http.sh` 实跑;task-orch 由 `agent-invoke.test.mjs` 的 dist 真实 HTTP 测试覆盖。
4. **疑点最小实验**:对「spawn 失败的事件顺序」不做纸面推断,用 10 行 Node 实验实证(见 §三 W-1)。

另记录一次**假警报排除**:diff 输出中的 `[m`/`2m` 疑似 ANSI 垃圾字符,经 `cat -v` 直读源文件确认为 git 彩色 diff 的显示残迹,源文件干净、`tsc` 通过——不构成发现。

## 二、验证结果

| 项 | 结果 |
| --- | --- |
| agent-catalog-server `node --test` | **15/15 通过** |
| 代码审查智能体 `npm test` | **69/69 通过**(含既有 5 个 .ts 测试文件零回归) |
| 错别字检测智能体 `pytest` 全量 | **202/202 通过**(38 既有 + 59 新增 api + 其余既有,零回归) |
| 任务编排智能体 `npm test`(build + node --test) | **13/13 通过**;`tsc` 构建干净 |
| code-review `scripts/smoke_http.sh`(mock 全链) | **PASS**(submit→status→result,401/405/413 断言在测试内) |
| typo-check `scripts/smoke_http.sh`(fake runner 全链) | **PASS**(含坏口令 401 断言) |
| spawn 事件顺序实验 | `["error:ENOENT","close:-2"]`——`close` 在 `error` 后必然补发 |

## 三、发现(3 警告 + 5 建议,按严重度排序)

### 警告级(全部集中在代码审查智能体仓,均为小修)

**W-1 `runReview` 双 finish,spawn 失败的可诊断信息被覆盖**(`server.mjs:186-238`)
`finish()` 无幂等守卫。Node ≥15 在 spawn 失败时**先 `error` 后 `close(-2)` 双发**(本轮已实验实证):`error` 分支写入的「无法启动审查 CLI:spawn npx ENOENT」会被 `close` 分支的「审查 CLI 退出码 -2。」覆盖。失败场景:runbook §3.3 预判的头号部署陷阱(launchd 默认 PATH 找不到 `npx`)发生时,运维看到的正是这条莫名的「退出码 -2」,runbook 设计的快速诊断线索被废,排障退化为翻日志。修法:`finish()` 加 `let finished` 一次性守卫(三行改动)。

**W-2 `job-store` 三函数循环内裸 `JSON.parse`,单个坏文件打崩整个服务**(`job-store.mjs:65-102`)
`countActive`/`cleanupExpired`/`markInterruptedOnBoot` 对 `jr_*.json` 无逐文件容错。失败场景:`data/jobs` 里出现任一损坏的 `jr_*.json`(磁盘坏、误操作)后,`cleanupExpired` 挂在 `setInterval` 上**每 10 分钟必然把服务打成未捕获异常崩溃**,KeepAlive 变无限崩溃循环——一个坏文件瘫痪四分之一服务面。修法:逐文件 `try/catch continue`,与 Python 镜像模块(`jobstore.py:110-113`)及同批 `entries-store.mjs` 的容错姿态对齐。
**复核订正(2026-10-14,独立复核实测,本条为低估而非夸大)**:① `markInterruptedOnBoot` 在 `server.mjs:57` **启动时同步执行、先于 `listen`**,坏文件使服务在 boot 阶段即崩——KeepAlive 崩溃循环是**立即**的,等不到第一个 10 分钟(已实测:boot 与 setInterval 两条路径均抛 `SyntaxError`);② 上方处方范围不全:`readJob`(`job-store.mjs:55`)同样是裸 `JSON.parse`,且被 status/result 请求处理器同步调用——只修三函数循环后,坏文件仍可循请求路径打崩服务,修复时须把 `readJob` 一并纳入容错。

**W-3 `<jobId>-out-*` 工作目录在崩溃路径下永久泄漏**(`server.mjs:156` + `job-store.mjs:76-89`)
临时 outDir 只在 `finish()` 正常/失败收尾时删除;进程中途死亡(kill -9/OOM/断电)后,boot 只把作业标 `interrupted`,清理器只删 json + report.md,**不删 outDir**。失败场景:公用机长期运行,每次中途崩溃的长任务留下一个 MB 级工作目录,无人可见、无人清理,`data/jobs` 无限膨胀。修法:`cleanupExpired`/`markInterruptedOnBoot` 连带删除 `job.outDir`(校验路径落在 `JOBS_DIR` 内再 `rmSync -r`;Python 侧 `cleanup_expired` 已同样删除 tg-data,`jobstore.py:151-153`,应对齐)。

### 建议级(不阻塞 A4,随联调消化或登记)

**S-1 坏 JSON body 三种处置**:code-review 200 `ok:false`(server.mjs:345)/ typo-check 200 `ok:false`(app.py:157)/ task-orch **500**(agent-invoke.ts:60);另 typo-check 缺报告返回 500 `{"detail"}`(app.py:133)而 code-review 同场景是 200 `ok:false`「作业报告已丢失,请重新提交」(server.mjs:295)。建议统一 200 `ok:false`——客户端可自纠的错误不该伪装成传输级故障。
**S-2 status 字段跨服务不一致**:Python 返回 `createdAt/updatedAt`(app.py:109-110),JS 返回 `elapsedSeconds`(server.mjs:268,设计 §3.2 指定);progress 一边是 camelCase dict(app.py:50-57)一边是自由文本「已产出 N/M 份报告」。统一词汇是设计 §3.1 的承诺,建议对齐或登记差异。
**S-3 task-orch `skipped` 复用「已触发」文案**(agent-invoke.ts:89-93):skipped 实际是上一轮仍在执行、本次未触发,execId 指向 skipped 记录;建议按 outcome 区分文案。
**S-4 typo-check 无请求体上限**(app.py:150-157):三服务中唯一无 64KiB→413 帽者;LAN+口令缓解,建议补 `Content-Length` 检查对齐。
**S-5 `JOBS_DIR` 默认相对 CWD**(`__main__.py:61`):同文件 `_REPO_ROOT` 已存在且 `.env` 用它锚定,jobs 目录却没有;runbook 模板已用绝对路径注入缓解,建议默认也锚到 `_REPO_ROOT / "data/jobs-api"`。**复核订正(2026-10-14)**:佐证句归因不准——`.env` 的 `_REPO_ROOT` 锚定代码实际在 `runner.py:40-45`(`env_path = _REPO_ROOT / ".env"`),`__main__.py` 本身不加载 `.env`;`_REPO_ROOT` 存在于 `__main__.py:25` 属实,建议项不受影响。

## 四、实现质量亮点(评审中确认站得住的部分)

1. **`triggerNow` 的 `wasRunning` 预捕获**(`d2e540b`):正确解决了 mutex-skip 被误判为 triggered 的并发歧义(调用前捕获 running 态 + 同步前缀推演),实现期自查发现真坑并修对——这是全计划最微妙的一处并发推理。
2. **契约对齐的实修**:两仓「请求信封统一读 `arguments` 对象 + jobId 格式守卫」(`d6fd300`/`baa929b`)、「失败名单改从 stderr 解析,汇总缺失回退计数不再静默为 0」(`8f0fb35`)、「畸形百分号编码不打崩目录服务」(`7b2da2f`)、「runner 前置 I/O 入 try」(`658b5aa`)——fix commit 链显示实现者在自我验证中真跑了契约对照。
3. **分片纪律严格落地**:JS/Python 两版信封模拟均与真实线形逐字段一致(含 `nextOffset`,修正 `1fc2873`);Python 侧 `json.dumps` 默认带空格分隔符,模拟值**保守偏大**——宁小勿超,方向正确。
4. **`drain()` keep-alive 卫生**(agent-invoke.ts:151-155):短应答(401/503/405)先排空请求体再回,避免 pipelined 连接错位——多数实现会漏掉的细节。
5. **F2 修复精确落地**:runner.py:40-45 的 `.env` 存在性守卫与评审修订稿逐字一致,注释准确描述 `FileNotFoundError` 行为。
6. **runbook 质量突出**:`launchd PATH/npx` 陷阱、Node 22 `--experimental-sqlite` import 即崩、task-orch 503-vs-401 探活口径、转发器方案的安全裸奔警告与 `--host` 根治,全部预判到位(§1/§2/§3.4/§6.3/§8)。
7. **Python jobstore 的原子写带 `fsync`、统计函数逐文件容错**——比 JS 镜像更稳(反衬 W-2 应向它看齐)。
8. **smoke 脚本可用性**:fixture 自造、就绪轮询、清理 trap、断言全链,两条实跑 PASS,可直接用于公用机质检留档。

## 五、结论与后续

1. **代码评审通过**:M-A0~M-A3 的实现与最终通过的计划逐 Task 对齐,四仓 299 项测试 + 两条 smoke 全绿;无 critical 发现。
2. **开工 M-A4 的前置**:修复 W-1/W-2/W-3(三处均 code-review 仓、合计约半小时改动),跑 `npm test` + `smoke_http.sh` 回归后即可进入 M-A4 联调。
3. **S-1~S-5**:随 A4 联调顺手处理或在各仓 README 登记为已知差异;不构成阻塞。
4. **流程备注**:计划文件 87 个 checkbox 均 未回勾(`0/87`)——实现已按 Task 顺序完成并留有 commit 链,建议补勾或声明「以 commit 链为执行凭证」,避免后续读者误判执行状态。

—— 代码评审完(评审链就此收口:设计 → 计划 → 代码,全链通过)——

---

## 六、处置记录(2026-10-14,评审方执行修复)

| 发现 | 处置 | 落点 | 回归钉 |
| --- | --- | --- | --- |
| W-1 双 finish | `finish()` 加一次性守卫,spawn 失败时保留首条 ENOENT 错误 | code-review 仓 `60b6b52` | 破坏 PATH 实测 error→close(-2) 双发路径,断言「无法启动审查 CLI…ENOENT」且 `退出码 -2` 不出现 |
| W-2 裸 JSON.parse | `readJobFileTolerant` 逐文件容错(坏文件跳过并警告),countActive/cleanup/markInterrupted 三函数共用 | code-review 仓 `60b6b52` | 坏 `jr_*.json` 与好作业并存:统计/改写/清理全部不崩,坏文件原样保留(运维可见) |
| W-3 outDir 泄漏 | `removeStaleOutDir` 由 cleanupExpired 与 markInterruptedOnBoot 连带调用;**路径越界(JOBS_DIR 外)不动**,防记录被篡改后误删任意目录 | code-review 仓 `60b6b52` | 启动整理/超龄清理各删遗留 outDir;越界路径标记 interrupted 时不触碰 |
| S-1 坏信封 500 化 | task-orch 坏 JSON 与缺 arguments 改 200 `ok:false`;typo-check 缺报告改 200 `ok:false「作业报告已丢失,请重新提交」` | task-orch `3f54ddb`;typo-check `942ff91` | 三仓同口径断言(坏 JSON / 缺 arguments / 缺报告) |
| S-2 status 形状 | typo-check status 以 `elapsedSeconds` 取代裸 createdAt/updatedAt;progress 由 camelCase dict 改自由文本「已扫描 3/10 块、预计剩余约 N 分钟」 | typo-check `942ff91` | 断言文本 progress、elapsedSeconds≥0、原始时间戳不再外露 |
| S-3 skipped 文案 | 按 outcome 区分:「上一轮仍在执行,本次未触发,已记 skipped,可用 runs/show 查看」 | task-orch `3f54ddb` | 慢端点(1.5s 应答)在飞期间 HTTP run → outcome=skipped + 新文案,execId 指向 skipped 落库记录 |
| S-4 无 body 上限 | 流式读体(`request.stream()`)超 64KiB → 413,覆盖 Content-Length 与 chunked,不做全量缓冲 | typo-check `942ff91` | >64KiB body 断言 413 + 中文错误体 |
| S-5 JOBS_DIR 半锚定 | 默认改锚 `_REPO_ROOT / "data/jobs-api"`(与 .env 同锚) | typo-check `942ff91` | —(runbook 本就以绝对路径注入,此处消除手动启动的坑) |

**处置中顺带发现并修复**:typo-check `test_cleanup_expired_boundary_age_equal_max_age_keeps` 为 **50% flaky**(6 跑 3 挂)——`time.time()` 亚微秒位经 `isoformat` 往返截断,`age == max_age` 等值断言随机翻面;改用整秒时间戳(ISO 往返无损)后 8/8 稳定。已并入 `942ff91`。

**全量回归(处置后实跑)**:agent-catalog-server 15/15 · code-review 74/74(+5 新回归钉)· typo-check 204/204(+3)· task-orch 15/15(+2),合计 **308/308 通过**;code-review 与 typo-check 两条 smoke 重跑 **PASS**。task-orch `tsc` 构建干净。

**判定:8/8 处置闭环,评审遗留清空,满足进入 M-A4 联调的全部前置。**
