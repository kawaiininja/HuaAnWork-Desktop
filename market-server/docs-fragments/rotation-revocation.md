# 轮换与吊销（market-server 部署 runbook 片段）

> 本文档是 `docs/market-server-deployment.md` 的**待合并片段**（Task 1 负责并入正文）。
> 来源：Task 0.5（签名信任锚供给），round3 R3/R9 + round4 C3/M3' + round5 N7 裁定。

## 信任锚形态（M5 单源裁定，P2③）

M5 只支持**一个 canonical 内网市场源**：单一钉扎 Ed25519 公钥 + 轮换期内的
上一把公钥（槽 2，带 `retiredAt` 退役时刻）。多源 keyring / 每源公钥延后 M6。
客户端 `sources` tab 在 M5 只展示并管理这一个 canonical 源，多源 UI 占位禁用、
注明 M6（Task 6 落 UI；与〈不改造清单〉⑤ 一致）。

- 算法：Ed25519（`node:crypto`，零新依赖）。
- 钉扎格式：**raw 32 字节公钥，小写 hex（64 字符）**。keyId = 公钥原始字节的
  sha256 hex 指纹。wrapper 侧以 JWK（`{kty:'OKP', crv:'Ed25519', x: base64url}`）
  重建 KeyObject，无需 PEM/SPKI 解析。
- 槽位：槽 1 = 当前钥；槽 2 = 上一把钥，`retiredAt` = 换钥时刻 + 一个 app
  发版窗口。验签为**三输入两槽判定**：分离签名 + 声明槽位 + 槽 2 `retiredAt`
  ——keyId 先对全部槽位解析（无命中即 `unknown-key`），再比对声明槽位
  （不符即 `slot-key-mismatch`），槽 2 过 `retiredAt` 即拒（`slot-retired`），
  最后做 Ed25519 验签（`invalid-signature`）。信封字段判定先于一切：
  `missing-field` / `unsupported-envelope-version` / `invalid-revision` /
  `revision-regression` / `invalid-timestamp` / `domain-mismatch` /
  `not-yet-valid` / `expired` / `ttl-exceeds-cap`。

## 真离线两步发布流（round3 R9）

私钥**永不进入 market-server 进程**（服务端只持配置公钥；原「env 注入私钥」
裁定作废）。发布一个清单：

1. 管理员在 market-server 管理面上架/更新制品；服务端计算 sha256 并生成
   canonical 待签清单（含防重放信封字段），输出 **pending manifest** 文件；
   未激活。
2. 签名管理员把 pending manifest 下载到**离线签名机**（私钥唯一居所），运行
   `node scripts/sign-manifest.mjs --manifest <pending.json> --key <market-signing-key.pem> --slot 1`，
   产出**分离签名** sidecar（`<pending.json>.sig.json`）。
3. 签名管理员把 sidecar 上传回 market-server；服务端用配置公钥做三输入两槽
   验签（含信封字段判定与 `revision` 单调检查），**通过才收录激活**——
   **fail-closed：无有效签名的清单不得激活**（Task 2 侧断言）。

密钥生成：`node scripts/gen-signing-key.mjs --out <仓库外目录>`。私钥
`market-signing-key.pem` 落盘 0600，**绝不入仓**——脚本拒绝在 git worktree
内写盘（.gitignore 另列 `market-server/keys/` 兜底）。公钥导出
`market-signing-key.pub.hex`（raw hex，即钉扎格式）并打印指纹。

## 暴露窗口陈述（round5 N7，必须原文并入 deployment.md）

`notAfter` 上限 = **7 天**（信封寿命 `notAfter - issuedAt ≤ 7d`，验签侧
`ttl-exceeds-cap` 强制）。**`notAfter` 上限即私钥泄露的最大暴露窗口：泄露后
攻击者用泄露私钥签出的清单，最长可用期 = 7 天**（受 `revision` 单调与
`domain` 钉扎进一步收窄）。因此**离线签名操作节奏（重签/签名）必须短于该
窗口**：每 ≤7 天重签一轮，或每次发布即签（推荐后者——发布即签使任何时刻在
效清单的 `notAfter` 都不超过下一次常规发布）。

## 正常轮换

1. 离线签名机 `gen-signing-key.mjs` 生成新钥对；新公钥指纹经**带外渠道**
   告知 app 发版负责人（见下「公钥分发与指纹核对」）。
2. 新私钥签新清单（`--slot` 用新槽位规划）；新清单 `revision` 继续单调递增，
   `notAfter` 照常 ≤ issuedAt + 7d。
3. app 发版把**新旧两把公钥**同时钉进 wrapper 配置（新钥进槽 1，旧钥退槽 2
   并带 `retiredAt` = 发版时刻 + 一个发版窗口）。
4. 重叠期内旧钥签名仍可验（槽 2 未过 `retiredAt`）；窗口过后槽 2 机判拒绝
   （`slot-retired`），旧钥签名自然失效——轮换重叠期 = 一个 app 发版窗口
   （round4 C3）。
5. 旧私钥离线销毁。

## 吊销（诚实表述，round3 R3）

**吊销能力 = app 发版换钥 + `notAfter` 到期。不存在在线吊销**——market-server
与 wrapper 之间没有、也不引入密钥状态在线查询通道；任何声称「立即吊销」的
说法都不符合本机制。私钥泄露处置：

1. 立即用**新**私钥以更高 `revision` 重签全部在效清单（缩短已签清单的剩余
   可用期只能靠签发替换清单——但注意：旧清单在客户端若 `revision` 更高曾
   被接受则无法被低 revision 替换，因此泄露响应的核心是第 2 步的换钥 +
   过期）。
2. 走「正常轮换」第 3 步：紧急 app 发版把泄露钥移出钉扎配置（最短路劲是把
   泄露钥的槽位置为空槽/移除）。未更新 app 的客户端：泄露钥签的清单最长
   再可用至其 `notAfter`（≤ 泄露发现时刻 + 7 天）。
3. 记录泄露时间窗，审计期间内以该钥签名的全部清单 revision。

## 公钥分发与指纹核对

- 公钥（raw hex）与指纹（sha256 hex）由 `gen-signing-key.mjs` 打印；指纹是
  唯一需要带外传递的值。
- 带外渠道：与 app 发版流程绑定的内部工单/签名邮件/口头 + 二次确认，**不得**
  经 market-server 自身通道回读（防自证）。
- 发版钉扎进 wrapper `config.ts`（Task 4 Step 3）前，负责人在离线签名机重算
  `sha256(raw pubkey)` 与带外指纹比对一致才允许合入；market-server 侧配置
  （Task 2）同口径核对。

## 离线签名操作纪律

- 私钥只在离线签名机落盘（0600），不出该机、不入任何版本控制、不经任何
  网络传输（用 U 盘/专人传递待签清单与签名产物）。
- 签名机不运行 market-server、不挂载内网共享盘。
- 每次签名记录 `signedAt`、所签清单 `revision`、所用槽位，供审计。
