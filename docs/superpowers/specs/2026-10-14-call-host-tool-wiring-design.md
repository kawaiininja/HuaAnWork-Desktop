# P1 修复 mini 设计:call_host_tool 注册接线 — 2026-10-14

- **缺陷**:`2026-10-14-a4-1-gui-run.md` §二——桌面 runtime 从未调用 `registerCallHostTool`,`@点名` HTTP 小工具链路断裂(模型会话内无该工具)。
- **定性**:桌面移植(Task 4 时代)接线缺失;**修复面收敛为单文件单点**(`dsh-plugin-huaanwork/src/huaanwork-host/index.ts`),不触碰共享三包文件。
- **状态**:待确认(确认后实施;实施后按 A4-1 复测清单收口)

## 一、事实修正(对 A4-1 证据记录 §二 的订正)

证据记录曾称「present-as 需第二处联动放行」——**经本轮设计核实不成立**,订正如下:

| 环节 | A4-1 记录的判断 | 本轮核实(准确) |
| --- | --- | --- |
| `present-as.ts` 收窄 | 需联动放行 host-attached 会话 | **无需改动**:`call_host_tool` 已在 `ALLOWED_TOOLS`(present-as.ts:27),注册后不会被任何会话的 restrict 滤掉 |
| `decide.ts` 执行门禁 | 已就绪(不变) | 已就绪:`case "call_host_tool": attached ? (full→allow : ask) : deny("工具…未附加到当前会话")`(decide.ts:111-112) |
| `agent-tool.ts` 的 `apply` 监听器(ask 文案) | 未提及 | **已在组合**:`profile.ts:1553`(`huaanwork-agent-tool` 行) |
| 唯一缺口 | registerCallHostTool 无调用方 | **确认成立**:全仓仅测试调用;本设计补上生产调用 |

## 二、改动设计(单点)

### 2.1 落点与形态

`huaanwork-host/index.ts`,在 `:128`(首次 `ctx.huaanworkAgentCatalog.current = agentsHost.snapshotForRuntime()`)之后,按 `:149-154` 的既有子插件注入先例(skills 恢复用的 `ctx.plugin({ inject: [...], apply })`)新增:

```ts
// call_host_tool 注册接线(P1 修复):工具经 huaanwork-guardrails/agent-tool 注册,
// 执行期读 live holder(agent-tool.ts:151-152),描述在目录变更时重注册刷新。
// 可见性全局(present-as ALLOWED_TOOLS:27 已含),执行由 policy 按会话附件门禁
// (decide.ts:111-112:unattached → deny)——与旧 sidecar 行为一致的纵深防御。
ctx.plugin({
  inject: ['tools'],
  apply: (pc: Context) => {
    pc.effect(() => {
      let unregister = registerCallHostTool(pc, ctx.huaanworkAgentCatalog.current)
      syncHostToolDescription = () => {
        unregister()
        unregister = registerCallHostTool(pc, ctx.huaanworkAgentCatalog.current)
      }
      return () => {
        syncHostToolDescription = undefined
        unregister()
      }
    }, 'huaanwork: call_host_tool registration')
  },
})
```

并在 `createAgentsHost` 的 `onCatalogChange`(:123-125)里补一行:

```ts
onCatalogChange: () => {
  ctx.huaanworkAgentCatalog.current = agentsHost.snapshotForRuntime()
  syncHostToolDescription?.()   // 新增:描述随目录刷新(execute 本就读 live holder,不受陈旧描述影响)
},
```

`let syncHostToolDescription: (() => void) | undefined` 声明于 `createAgentsHost` 之前(闭包引用)。

### 2.2 时序与生命周期论证

| 关注点 | 论证 |
| --- | --- |
| **holder 先于注册**:holders.ts:120 初始化空 holder → index.ts:128 首次同步 → 子插件注册(拿到含本地入口的首帧快照);agent-invoke 的 @点名消费同一 holder,顺序无竞态 | ✅ |
| **注册顺序与 present-as 无关**:present-as 的会话收窄监听 `tools/change`(:55),注册即触发重收窄;`ALLOWED_TOOLS` 已含本工具,后注册不会被滤掉 | ✅ |
| **目录刷新**:`onCatalogChange` → 快照更新 + 重注册(先 unregister 再 register,幂等);本地入口增删经 rpc → refresh → onCatalogChange 同路径 | ✅ |
| **空目录**:`buildToolDescription` 对空清单给出「当前无已启用的公用机小工具」文案(agent-tool.ts:88-89),注册不因空快照失败 | ✅ |
| **卸载清理**:`pc.effect` 返回 disposer——插件卸载/generation 重启时 unregister,不留悬挂工具行 | ✅ |
| **未附加会话可见性**:全局可见 + policy deny(设计内纵深,decide.ts:112 的 deny 文案即「未附加到当前会话」);与旧 sidecar 全量注册的行为一致 | ✅ |

### 2.3 不改的东西(明确)

- `present-as.ts` / `policy.ts` / `decide.ts` / `agent-attachments.ts`:零改动(事实修正见 §一);
- `agent-tool.ts` 本体:零改动(已有实现与 cordis spec 契约足够);
- 三包共享文件:零触碰——唯一改动文件在 `src/huaanwork-host/` 单侧前缀下,`check:desktop-variants` 预期零占额。

## 三、测试

1. **新增 cordis 集成测试**(`tests/huaanwork-host/agent-tool-wiring.cordis.spec.ts`,同仓 cordis harness 既有模式):
   - host 组合完成后,`tools.schemas()` 含 `call_host_tool`,描述文本含已启用本地入口名;
   - 经 `agent.addEndpoint` rpc 增入口触发 `onCatalogChange` 后,描述刷新含新入口名;
   - effect 卸载后 schema 不再含 `call_host_tool`(disposer 生效);
   - 空 holder 场景注册不抛(空清单文案)。
2. **回归**:`corepack yarn test`(既有 `agent-tool.cordis.spec.ts` 7 用例、present-as/policy cordis 全量);`corepack yarn check:desktop-variants`(预期无新增占额);`corepack yarn typecheck`。
3. **端到端复测**:按 `2026-10-14-a4-1-gui-run.md` §三 清单重跑 A4-1(@code-review 全链 → typo-check → task-orch 八 action → 错口令 401 → 启停/删除),证据补齐后 A4-1 收口、衔接 A4-2。

## 四、对抗性自查(设计层已自证伪的项)

- ~~「present-as 需联动」~~ → 证伪(ALLOWED_TOOLS:27 已含),已订正记录;
- ~~「需要 per-session 注册」~~ → 证伪:注册是全局单工具,per-session 语义由 policy 附件门禁承担(decide.ts:111-112),注册侧再做会话级注册反而破坏 `tools/change` 的重收窄模型;
- ~~「描述必须实时」~~ → 弱化为「描述经 onCatalogChange 刷新即可」:execute 读 live holder(agent-tool.ts:151),描述陈旧不阻断调用,只影响模型认知,重注册已覆盖;
- 残余风险:**未附加会话可见但 deny** 的模型行为——模型可能在无 @点名的普通会话里看到该工具并尝试调用,得到 policy deny 文案「工具…未附加到当前会话,请改用已附加的工具」——文案自解释,可接受;若复测发现本地模型因此分心,后续再议「仅 attached 会话可见」的收窄增强(另立裁定,不进本次最小修复)。

—— 完(待确认后实施)——
