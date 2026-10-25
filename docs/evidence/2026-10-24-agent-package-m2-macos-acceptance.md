# 智能体包 M2 macOS 双 Profile 验收证据

当前结论：**`PASS（本机探针）`**。探针退出码 **0**，11 个字段全为 `true`，
`residualProcesses` 为 **0**。

这不是 GUI 真机，也不是跨机器验收。它证明的是：真实目录服务 + 真实离线 CLI 子进程 +
两个 Profile 的签名包生命周期（发布 → 审查/签名 → 第二 Profile 安装 → 启用 → 真实 HTTP
运行 → 1.0.1 更新保留启用态 → 下架后已安装卡 `delisted` 且仍可运行 → 长回合撤销被中止 →
撤销版本不可再启用/分发），以及退出时零残留进程。

跨机器验收（macOS 创建者 + Windows 消费机 + 离线管理员）为 **`BLOCKED`**，见 §7。

## 1. 运行环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-25（本机时间；探针审计时间戳为 2026-10-25T04:05Z） |
| 机器 | MacBook Pro（Mac16,8，Apple M4 Pro，24 GB） |
| OS | macOS 27.0.1（build 26A434）；`os.release()` 报告 `27.0.0` |
| Node | v22.23.2（本机默认；类型剥离默认开启，未加额外 flag） |
| 架构 | arm64 |
| 分支 / worktree | `feat/agent-packages-m2`，`.worktrees/m2-agent-packages` |
| 探针运行时的 HEAD | `b952477a81c58ef8c36d613f56a5295b2d96394a` |
| 工作树状态 | HEAD 之上有 Task 13 未提交改动：探针脚本、workflow step、runbook、本证据、root 门禁。探针只依赖 Task 1–12 的已提交代码与自身；最终提交见 `git log -1 --format=%H -- docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md` |

## 2. 命令

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/.worktrees/m2-agent-packages
node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin.json
echo "EXIT=$?"
```

结果：`EXIT=0`。同一命令在本任务中连续运行三次（两次早期调试失败、一次 `EXIT=0` 之后又
复跑一次确认可重复），最后一次仍为 `EXIT=0`、`residualProcesses=0`、`auditLines=37`。

## 3. 临时测试环境说明

本次运行的全部材料都在一次性临时目录里，运行结束即删除：

- `entries/`：空的旧 M-A0 条目目录；`data/`：服务端 `state.json`、`audit.jsonl`、
  `submissions/`、`packages/`；
- `keyring.json`：**每次运行现生成**的 Ed25519 公钥（slot 1）；私钥只写在同一临时目录的
  `signing-key.pem`（0600），从不打印、从不提交；
- `creator-profile/`、`consumer-profile/`、`third-profile/`：两个 Profile 加一个重放负例用的
  空 Profile；`workspace/`：HTTP fixture 子进程的工作目录；
- 三个 token 每次随机生成且两两不同；报告与日志里不出现 token 或私钥。

`tempRoot`（报告原值 `/var/folders/.../T/huaanwork-m2-accept-3AlxCC`）在运行结束后已被删除，
因此不能用来重放；重放请重新执行 §2 的命令。

## 4. 探针原始 JSON

以下为 `/tmp/agent-package-m2-darwin.json` 原文，未修改字段值。

```json
{
  "submitted": true,
  "reviewedAndSigned": true,
  "secondProfileInstalled": true,
  "signatureVerified": true,
  "enabledAndHttpRan": true,
  "updatedPreservingEnabled": true,
  "delistedInstalledStillRan": true,
  "delistedStatusVisible": true,
  "revocationStoppedActiveTurn": true,
  "revokedEnableRejected": true,
  "residualProcesses": 0,
  "kind": "huaanwork-agent-package-m2-acceptance",
  "platform": "darwin",
  "commit": "b952477a81c58ef8c36d613f56a5295b2d96394a",
  "runner": {
    "os": "darwin",
    "osRelease": "27.0.0",
    "name": "MacBook-Pro-14.local",
    "arch": "arm64",
    "node": "v22.23.2"
  },
  "scope": {
    "server": "agent-catalog-server in-process, real HTTP, ephemeral loopback port",
    "adminCli": "agent-catalog-admin/src/cli.ts spawned as a child process",
    "gui": false,
    "realModel": false,
    "note": "No GUI, no model interview and no packaged app. The sandbox is a passthrough seam; sandbox enforcement is covered by the M1 Windows sandbox probe."
  },
  "environment": {
    "note": "entriesDir, dataDir, keyring, profiles and workspace are throwaway directories under the OS temp dir; the Ed25519 keypair is generated per run and never committed; all three tokens are random per run."
  },
  "tempRoot": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-F6WAxb",
  "steps": {
    "submitted": {
      "submissionId": "fe825346-5040-4ddd-8b42-04c47ecaeedd",
      "slug": "m2-acceptance-agent",
      "version": "1.0.0",
      "publishStatus": "pending-review",
      "catalogList": {
        "items": []
      }
    },
    "reviewedAndSigned": {
      "cli": [
        {
          "command": "agent-catalog-admin pending",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin review",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin approve",
          "exitCode": 0
        }
      ],
      "publishedStatus": "published",
      "signedKeyId": "56fd1c22e3c5ad97dd2e9b5a35426e41925a22abe6b0c997eda28979fdcad7f7",
      "receipt": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-F6WAxb/review-1.0.0/review.json",
      "creatorPublishStatus": "published"
    },
    "secondProfileInstalled": {
      "profile": "consumer-profile",
      "version": "1.0.0",
      "enabled": false,
      "publishStatus": "installed",
      "creatorProfileState": "published"
    },
    "signatureVerified": {
      "keyId": "56fd1c22e3c5ad97dd2e9b5a35426e41925a22abe6b0c997eda28979fdcad7f7",
      "slot": 1,
      "version": "1.0.0",
      "digestFiles": 4,
      "note": "verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519."
    },
    "enabledAndHttpRan": {
      "version": "1.0.0",
      "httpPort": 52255,
      "health": {
        "status": 200,
        "body": "ok"
      },
      "invoke": {
        "ok": true,
        "result": {
          "echo": {
            "task": "m2-acceptance",
            "version": "1.0.0"
          }
        }
      },
      "activationDisposed": true,
      "portClosedAfterIdle": true,
      "sandbox": "passthrough (M2 checks signed-package lifecycle; M1 probe owns sandbox enforcement)"
    },
    "updatedPreservingEnabled": {
      "cli": [
        {
          "command": "agent-catalog-admin review",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin approve",
          "exitCode": 0
        }
      ],
      "from": "1.0.0",
      "to": "1.0.1",
      "enabled": true,
      "publishStatus": "installed"
    },
    "delistedStatusVisible": {
      "cli": [
        {
          "command": "agent-catalog-admin delist-requests",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin delist-approve",
          "exitCode": 0
        }
      ],
      "requestId": "347d5067-7bd8-4ac4-93aa-8d369732ab38",
      "publishStatus": "delisted",
      "enabled": true,
      "card": {
        "publishStatus": "delisted",
        "enabled": true,
        "broken": null
      },
      "refreshChanged": true
    },
    "delistedInstalledStillRan": {
      "version": "1.0.1",
      "invoke": {
        "ok": true,
        "result": {
          "echo": {
            "task": "m2-acceptance",
            "version": "1.0.1"
          }
        }
      },
      "note": "delisted metadata changes the card, not the runtime; revocation is the security control.",
      "portClosedAfterIdle": true
    },
    "revocationStoppedActiveTurn": {
      "cli": {
        "command": "agent-catalog-admin revoke",
        "exitCode": 0
      },
      "warnings": null,
      "session": "m2-acceptance-session-3",
      "httpPort": 52275,
      "activationDisposed": true,
      "activationResultPending": true,
      "portClosed": true,
      "state": {
        "enabled": false,
        "revokedVersion": "1.0.1",
        "revokedReason": "M2 验收:撤销当前版本"
      }
    },
    "revokedEnableRejected": {
      "enableError": "智能体 @m2-acceptance-agent 已损坏:该版本已被管理员撤销：M2 验收:撤销当前版本",
      "staleDispatchError": "该版本已被管理员撤销：M2 验收:撤销当前版本",
      "assertRunnableError": "该版本已被管理员撤销：M2 验收:撤销当前版本",
      "cardBroken": "该版本已被管理员撤销：M2 验收:撤销当前版本"
    },
    "finalState": {
      "creator": {
        "source": "local",
        "enabled": true,
        "installedVersion": "1.0.1",
        "publishStatus": "published",
        "publishedVersion": "1.0.1",
        "submissionId": "2a613e57-10d1-41c8-b684-9a2c678d45da",
        "delistRequestId": "347d5067-7bd8-4ac4-93aa-8d369732ab38"
      },
      "consumer": {
        "source": "catalog",
        "enabled": false,
        "installedVersion": "1.0.1",
        "publishStatus": "delisted",
        "revoked": {
          "slug": "m2-acceptance-agent",
          "version": "1.0.1",
          "reason": "M2 验收:撤销当前版本",
          "revokedAt": "2026-10-25T04:12:17.568Z"
        }
      },
      "auditLines": 37
    }
  },
  "negatives": {
    "wrongToken": {
      "status": 401,
      "body": {
        "error": "口令错误"
      },
      "ok": true
    },
    "unknownKey": {
      "error": "包校验失败，未安装或未运行。请联系管理员",
      "ok": true
    },
    "tamperedContent": {
      "error": "包校验失败，未安装或未运行。请联系管理员",
      "ok": true
    },
    "olderVersionReplay": {
      "error": "该版本不是目录中的最新版本，已拒绝安装",
      "ok": true
    },
    "revokedVersionInstall": {
      "error": "目录中没有版本 1.0.1",
      "ok": true
    },
    "coveredByIntegrationTests": {
      "unsignedOrSignatureCarryingBundle": "packages/agent-package-format/tests/bundle.test.ts",
      "extraFilesAndMismatchedManifest": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts",
      "retiredAndWrongKeys": "agent-catalog-server/tests/submissions.spec.ts",
      "tooManyEntriesAndLongPaths": "packages/agent-package-format/tests/bundle.test.ts",
      "downgradeAndDelistedLatest": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts",
      "wrongPublishOrAdminToken": "agent-catalog-server/tests/auth-legacy.spec.ts",
      "revocationAndActiveTurn": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts"
    }
  },
  "cleanup": {
    "scannedProcesses": 819,
    "matches": [],
    "command": "ps -ax -o pid=,command=",
    "note": "Matches are processes whose command line references the throwaway temp root; the probe itself is excluded."
  },
  "verdict": "PASS",
  "exitCode": 0
}
```

## 5. 逐字段说明

| 字段 | 证据 |
| --- | --- |
| `submitted` | 创建者 Profile 的本地包 `publishLocalAgentPackage` 返回 `submissionId`，状态写入 `pending-review`；公开列表此时为空（未发布）。 |
| `reviewedAndSigned` | CLI `pending`/`review`/`approve` 三次子进程退出码 0；批准后 `GET /v1/agent-packages/{slug}/1.0.0` 为 `published`，`approve` 打印的 keyId 与临时公钥一致。 |
| `secondProfileInstalled` | 第二个 Profile 安装 1.0.0；首次安装 `enabled:false`、`source:'catalog'`、`publishStatus:'installed'`。 |
| `signatureVerified` | 安装目录用独立 keyring 复验：keyId 一致、slot 1、version 1.0.0、digest 覆盖 4 个文件。 |
| `enabledAndHttpRan` | 启用后经真实 `createAgentPackageHost().dispatch()`：HTTP fixture 子进程 `/health` 返回 200 `ok`，`POST /invoke` 回显 `{task:'m2-acceptance',version:'1.0.0'}`；`afterIdle` 后端口关闭。 |
| `updatedPreservingEnabled` | 发布 1.0.1 并经 CLI 审查/签名后 `updateCatalogAgentPackage` 升到 1.0.1，`enabled` 仍为 true。 |
| `delistedInstalledStillRan` | 下架 1.0.1 后再次真实 HTTP 运行成功（回显 version 1.0.1）；说明下架改的是 metadata，不是运行时。 |
| `delistedStatusVisible` | `refreshInstalledCatalogPackageStatuses()` 报告 `changed:true`；已安装卡 `publishStatus:'delisted'`、`enabled:true`、无 `broken`。 |
| `revocationStoppedActiveTurn` | 长回合 activation 的 result 永不结算；CLI `revoke` 后 `refreshRevocations()` 立刻 dispose activation（`activationDisposed:true`、`activationResultPending:true`）、停止 HTTP 子进程（端口关闭）、state 写 `enabled:false` + `revoked`。 |
| `revokedEnableRejected` | 对已撤销版本：`setEnabled(true)` 被拒绝、stale 详情 dispatch 被拒绝、`assertRunnable` 被拒绝、卡片标 `broken`；四处文案都是撤销原因。 |
| `residualProcesses` | 停止所有运行时后 `ps -ax -o pid=,command=` 扫描 820 个进程，命令行引用临时目录的进程为 0。 |

探针内的安全负例（同一次运行，全部为 `ok:true`）：

- 错误 token → HTTP 401 `{"error":"口令错误"}`；
- 未知 key → `包校验失败，未安装或未运行。请联系管理员`；
- 篡改 persona（复制一份后改动）→ 同一句失败文案；
- 旧版本重放（1.0.1 已发布时安装 1.0.0）→ `该版本不是目录中的最新版本，已拒绝安装`；
- 撤销版本安装（1.0.1 此时既已下架又已撤销）→ `目录中没有版本 1.0.1`。撤销让该版本从
  “可发布版本”集合中消失，安装路径因此拒绝；这是撤销在分发面上的表现，不是“已安装副本
  已被删除”（已安装副本见 `revocationStoppedActiveTurn`）。

其余负例（未签名/夹带签名内容、额外文件、1025 个 0 字节条目、513 字节规范化路径、退休
key、降级、错误发布/管理 token、撤销与在途回合）由既有集成测试覆盖，文件见 JSON 的
`negatives.coveredByIntegrationTests`；`corepack yarn test` 本轮全绿（见 §6）。

## 6. 本轮门禁（同一工作树）

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `node scripts/verify-layout.mjs` | 0 | 16 个 workspace 一致；上游 `1600d8a1e1` |
| `corepack yarn check:desktop-variants` | 0 | stable↔beta 7、beta↔huaanwork 64、`oneSidedPrefixes` 6 |
| `corepack yarn typecheck` | 0 | 含四个新 workspace |
| `corepack yarn test` | 0 | 含 `@huaanwork/catalog-signing`、`@huaanwork/agent-package-format`、`agent-catalog-server`（143 files）、`agent-catalog-admin`（14 tests） |
| `corepack yarn check` | **1** | **在第一步 `check:whitespace` 失败**，原因是 HEAD 上既有的空白缺陷：`dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts:558: new blank line at EOF.`（由 `b952477a81` 引入，非 Task 13 改动；该文件不在本任务可改范围） |
| `corepack yarn check:layout` | 0 | 同上 whitespace 之外的全部 layout 子项 |
| `corepack yarn test:aa-connector` | 0 | |
| `corepack yarn workspace dsh-community-fabric check` | 0 | |
| `corepack yarn workspace dsh-community-market check` | 0 | |
| `corepack yarn workspace dsh-plugin-desktop check` | 0 | |
| `corepack yarn workspace dsh-plugin-desktop-beta check` | 0 | |
| `corepack yarn workspace dsh-desktop-next check` | 0 | |
| `corepack yarn workspace dsh-plugin-huaanwork check` | 0 | 含 M1 agent-package 测试与 `verify:aa`；本机顺序执行，未复现并发 flake |
| `corepack yarn workspace market-server check` | 0 | 含 signing/envelope 测试 |
| `corepack yarn workspace update-server check` | 0 | |
| `corepack yarn workspace @huaanwork/catalog-signing check` | 0 | |
| `corepack yarn workspace @huaanwork/agent-package-format check` | 0 | |
| `corepack yarn workspace agent-catalog-server check` | 0 | |
| `corepack yarn workspace agent-catalog-admin check` | 0 | |

因此：除 HEAD 上既有的 `check:whitespace` 缺陷外，`check` 链的**每个其余组件**都已单独执行并
通过。修复该缺陷需要改一行（删除 `agentPackagesLogic.spec.ts` 末尾多余空行），该文件不在
Task 13 的可改范围，留给 owner；修复后 `corepack yarn check` 预期回到 0。

## 7. 未做与已知边界

- **不是 GUI 真机**：没有打开 Electron 应用、没有会话访谈、没有确认卡、没有真实模型
  `@slug`。这些仍是独立的人工核对项。
- **沙箱是 passthrough**：本探针验证签名包生命周期；沙箱 `enforcement`、写入拒绝、读/网络
  观察由 M1 的 Windows sandbox probe 负责。真实产品的 dispatch 使用真实
  `sandbox-local`（探针只替换了 `confine`）。
- **同机双 Profile 只是集成测试**，不替代跨机器验收。
- **Windows 未运行**：本环境不能 push 分支/触发 `workflow_dispatch`（C21）。Windows 结论在
  `docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md` 记为 `BLOCKED`。
- **跨机器验收 `BLOCKED`**：只有一台机器。需要 macOS 创建者、Windows 消费机与离线管理员
  各留原始证据与进程清单；步骤见 Windows 证据文件 §4。
- 探针每次运行生成新 key/token，因此两次运行的 submissionId、keyId、端口不同属正常。
