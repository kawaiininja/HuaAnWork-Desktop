# M9-B 21 个 Desktop 兼容补丁 rc.1 重做

> GitHub issue: [kawaiininja/HuaAnWork-Desktop#5](https://github.com/kawaiininja/HuaAnWork-Desktop/issues/5)
> Epic:[#3](./2026-10-17-m9-upstream-sync-epic.md) | 前置:[#4 M9-A](./2026-10-17-m9-a-merge-and-vendor-refresh.md) | 后续:[#6 M9-C](./2026-10-17-m9-c-verification-and-acceptance.md)

## Context

Epic:M9 上游同步(#3)。前置:M9-A 完成(`vendor/dsh-runtime/0.2.1-rc.1/` 已建,处于「无补丁解析」预期中间态)。`patches/` 21 个 `*@0.2.1-alpha.1.patch` 全部钉死旧版本,sync 脚本对 rc.1 产物静默无补丁——本卡把它们逐条重做为 `*@0.2.1-rc.1.patch`。

权威依据:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(经 GLM 三轮评审订正)。该清单对 21 个补丁逐一给出意图、alpha.5/rc.1 证据、难度分档与重做陷阱。rc.1 = alpha.5 + 4 提交纯版本号行,清单结论对 rc.1 成立,动手时以 rc.1 构建产物为最终对照。

## Current State

- 21/21 判定「需重做」:0 已吸收、0 可放弃
- 难度分档:小 16、中 3(dsh-hmr、dsh-ptc-runtime-node、dsh 核心 hunk②③)、中-大 2(dsh-client-ui-plugin-manager、dsh-client-ui-settings-account)
- 关键陷阱(清单「备注」栏,逐条必须核对):
  - dsh-hmr:rc.1 `Service.init` 头部 `mainJob()` 前置解引用,旧两 hunk 方案不够,需补 `hasEsmCache` 空值守卫 + 类型放宽
  - dsh-ptc-runtime-node:`src/index.ts:224-227` 与 `src/persistent.ts:192-196` **两个现场必须同补**(persistent.ts 是本轮唯一真实增量)
  - dsh 核心:`ProfileContext` 已全 readonly,新增字段写 `readonly readPatches?`
  - dsh-client-ui-settings-shell:以 `order: 40` 为基底,勿回退成 10
  - dsh-host-directory-picker-browse:保留既有 abort 重抛(alpha.1 `:169` 起即有)
  - plugin-manager:上游已改 Installed/More 双 tab + `listed` 按 `official` 过滤,隐藏集合挂新过滤链
  - settings-account:8 个锚点全搬迁,`DesktopOnboardingEntry` 签名已改(`setVisible` 注入),ctx 回退需改签名
- R-M9-3(已裁定):#4 directory-picker-browse 继续 bridge,不换上游 `directory-picker-native`;#10 browse host 补丁保留

## Proposed Change

按清单 §1 的顺序:先 2 个中-大 → dsh 核心 + hmr + ptc → 16 小批量过。每个补丁:

1. 在 rc.1 vendor 产物上重打(产物路径/chunk 哈希以 rc.1 实际构建为准)
2. 逐条核对清单「备注」栏的特有陷阱
3. 命名 `*@0.2.1-rc.1.patch`,删除对应 `@0.2.1-alpha.1` 旧文件
4. 每完成一批跑 `check:vendored-runtime` + 受影响包测试

随本卡落盘:#12(`dsh.optionalBundles` 清单形态)与 #17(sandbox-windows-acl 自愈)登记为「与上游明示取向相左」的永久 fork 差(上游依据分别在 agent note `2026-09-15-shipped-optional-bundles.md` 与 README.md:130),登记格式对齐债表既有行。

## Acceptance Criteria

1. `ls patches/*@0.2.1-rc.1.patch | wc -l` = 21;`ls patches/*@0.2.1-alpha.1.patch | wc -l` = 0
2. `node scripts/sync-vendored-runtime.mjs --check --channel beta`(及 huaanwork)绿,且 21 个补丁全部实际命中(非静默跳过)——每个补丁的命中情况在报告中逐行列出
3. 处置清单 21 行逐条销号:每行标注「重打完成 + 证据(命令+退出码)」或「裁定替换 + 裁定记录」
4. 两个中-大补丁(plugin-manager、settings-account)各附一段「上游新结构 → 补丁映射」说明落 `docs/evidence/`,说明隐藏集合挂到哪条过滤链、onboarding 回退签名怎么改
5. hmr 补丁含 `hasEsmCache` 空值守卫;ptc 补丁覆盖 `index.ts` 与 `persistent.ts` 两个现场(grep 证据)
6. #12/#17 永久 fork 差登记落盘(债表行或独立登记文档,格式对齐既有)
7. `corepack yarn typecheck` 与 `corepack yarn test` 转绿(M9-A 记录的 fallout 清单逐条消除或经裁定转移)

## Testing Plan

| Layer | What | Count |
|-------------|------------------------------------|-------|
| Gate | 每批补丁后 `check:vendored-runtime` | ≥4 跑 |
| Unit | 受影响包的既有 spec(plugin-manager、settings-account、hmr、ptc、subprocess-local 等) | 全量 |
| 销号 | 清单 21 行逐条核对 | 21 条 |

## Rollback Plan

补丁粒度回滚:删单个 `*@0.2.1-rc.1.patch` 即回退该补丁(sync 回落无补丁解析,影响面隔离)。

## Effort Estimate

7–9 人日(中-大 2 × 3–4 + 中 3 × 1.5–2 + 小 16 × 2–3)。

## Out of Scope

- M9-A 的合并与 vendor 刷新(前置)
- 新制品构建与 A1–A19 重跑(M9-C)
- 上游已吸收/可放弃补丁——清单判定为 0;若动手时发现反例,先停工回报,不擅自改判定

## Related

- Epic:#3;前置:#4;后续:#6
- 权威清单:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`
