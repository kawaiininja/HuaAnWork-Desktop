# M9-C 验证链 + 新制品 A1–A19 重跑与 M9 收口

> GitHub issue: [kawaiininja/HuaAnWork-Desktop#6](https://github.com/kawaiininja/HuaAnWork-Desktop/issues/6)
> Epic:[#3](./2026-10-17-m9-upstream-sync-epic.md) | 前置:[#5 M9-B](./2026-10-17-m9-b-runtime-patches-rc1.md)

## Context

Epic:M9 上游同步(#3)。前置:M9-B 完成(21 个 rc.1 补丁落地、typecheck/test 绿)。本卡是 M9 的收口:完整验证链、真机冒烟、构建新制品、在新制品上重跑 M4 的 A1–A19 人类核对(本机、人机混合)、A10 单独裁决、推送与 CI 对账。

关键裁定(R-M9-4):托盘 A10(macOS 26 模板图零渲染)**不挡开工、挡收口**——本卡产出前不得宣布 M9 完成;A10 仍不通过时单独决定能否发,结论写入债表托盘行。

## Current State

- 2026-10-07 的 A1–A19 记录(`docs/huaanwork-m4-human-verification-2026-10-07.md`):17 项通过、A10 不通过(零渲染)、A19 负例通过;制品换过后该记录全部作废,须重跑
- A10 缺陷面:`dsh-plugin-huaanwork/src/tray-icons.ts`、`electron-shell-generation.ts`——两者都落在本轮 116 个上游提交会碰到的壳上,核对必须在含新上游的新制品上做
- 推送与 CI 对账先例(M8 Phase 6):`docs/evidence/2026-10-m8-push.md`(推送 SHA 对账)、`docs/evidence/2026-10-m8-ci-reconciliation.md`(逐格展开对账;初次 failure 是允许的,须有消解闭环)

## Proposed Change

1. 无头验证链:`corepack yarn install --immutable` → `corepack yarn check` → `corepack yarn typecheck` → `corepack yarn test`(各命令报告退出码与关键输出)
2. 真机冒烟(行为变化点,来自子模组评估):
   - 登录:凭据优先级反转(stored > env,alpha.2 起)——harness home 已存同名 key + 环境变量同名场景下确认登录账号选择
   - 市场:`installBundle` 重复安装从 `changed:false` 改为 `already-installed` 报错(alpha.2 起)——huaanwork 市场重复安装同一插件的错误呈现目检
   - 迁移幂等:`huaanwork-migration` fixture 对 rc.1 persistence 格式(新增 7 项)仍成立
   - profile-boot:`verify-profile-boot.mjs` advanced Web 图/minimal 挂载断言、guardrails hmr/jobs/web 锁
3. 构建新制品(macOS),安装到本机
4. A1–A19 重跑(人机混合:可自动化的项由 agent 驱动,原生重启框/目检类人工核对),记录落 `docs/huaanwork-m9-human-verification-<date>.md`,格式对齐 M4 记录
5. A10 单独裁决:通过 → 收口;仍不通过 → 把「能否发」的裁决与结论写入债表托盘行
6. 推送 + CI 对账(按 M8 Phase 6 先例:推送 SHA 对账 + CI 逐格展开记录落 `docs/evidence/`)

## Acceptance Criteria

1. 四条无头命令各自报告命令原文 + 退出码 + 关键输出行,全绿
2. 四项真机冒烟各有一行结论 + 证据(截图/日志/命令输出),行为与预期差异逐条记录
3. A1–A19 重跑记录落盘,每项标注 通过/不通过/阻塞 + 证据;A10 的裁决结论写入债表托盘行
4. 推送后 `origin/master` SHA 与本地一致;CI run 逐格对账落 `docs/evidence/2026-10-m9-ci-reconciliation.md`
5. 债表 M9 行状态推进为收口(或「收口除 A10 外挂起」并附裁决)
6. 全程未先修 A10(R-M9-4 遵守声明)

## Testing Plan

| Layer | What | Count |
|-------------|------------------------------------|-------|
| 无头 | check / typecheck / test | 各 1 跑 |
| 真机冒烟 | 凭据优先级、重复安装语义、迁移幂等、profile-boot | 4 项 |
| 制品核对 | A1–A19 重跑 | 19 项 |

## Rollback Plan

收口前任何一步失败:worktree 保留现场,按失败层回退(补丁级 → vendor 级 → 合并级)。已推送后发现问题:按提交逆序 revert。

## Effort Estimate

3–5 人日(验证链 0.5 + 真机冒烟 1 + 制品构建与 A1–A19 重跑 1.5–2.5 + 推送对账 0.5–1)。

## Out of Scope

- A10 托盘图标缺陷修复本身(独立缺陷行;本卡只重测与裁决)
- A20–A28 环境阻塞项(凭据/Windows 主机/旧树/内网机)
- Windows 制品校验(独立债行)

## Related

- Epic:#3;前置:#5
- M4 核对基线:`docs/huaanwork-m4-human-verification-2026-10-07.md`
- M8 Phase 6 先例:`docs/evidence/2026-10-m8-push.md`、`docs/evidence/2026-10-m8-ci-reconciliation.md`
