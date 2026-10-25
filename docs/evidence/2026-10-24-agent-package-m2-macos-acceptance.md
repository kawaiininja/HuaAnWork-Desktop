# 智能体包 M2 macOS 双 Profile 验收证据

当前结论：**`PASS（本机探针）`**。最终探针运行退出码 **0**，11 个字段全为 `true`，
`residualProcesses` 为 **0**。

> **2026-10-25 补救轮（Task 13 / I-17）**：最终运行已前移到代码提交
> **`650e749af7`**（`test: drive M2 acceptance through the real packageRefresh RPC`），
> 下架/撤销卡片改由真实 `agent.packageRefresh` RPC 组合链产出，`host.listLocal()` 降级为
> 标注的交叉核对。**当前有效的最终证据是 §8**；§1–§7 保留为 `c144a73383` 轮的历史归档，
> 其 `delistedStatusVisible` / `revocationStoppedActiveTurn` 两行来自 helper 而非产品路由
> （I-17 指出的缺口），不再作为该两项的有效证据。补救轮有一处命令级偏差（Node strip-only
> 无法 import `routes.ts`），见 §8.2，必须连同阅读。Windows 侧的同一结构问题已在实际 GHA
> 运行中复现，见 `2026-10-24-agent-package-m2-windows-acceptance.md` §8。

历史轮次（§1–§7）的最终一次运行 HEAD 是代码提交 **`c144a73383`**
（`fix: close final review findings`，干净工作树），探针报告的 `commit` 即该 SHA。本证据
文件的更新是它的**下一个提交**（`docs: archive final M2 acceptance evidence`；内容提交无法
在自身内部写出自身 SHA；精确值用
`git log -1 --format=%H -- docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md`
查询）。最终评审修复轮之前的运行（`13bb3fc90b`）只算**中间运行**（见 §2 的运行计数）。

> **2026-10-25 fix round 1（裁定 R-T13-1）**：**权威运行是 §9**。它在代码提交
> `f2eebef933` 上以 `node --experimental-transform-types …` 执行，退出码 0；§8 是同一代码
> 的首次成功运行（以 transform-types 手工绕开 strip-only 的 import 限制），保留不删。

这不是 GUI 真机，也不是跨机器验收。它证明的是：真实目录服务 + 真实离线 CLI 子进程 +
两个 Profile 的签名包生命周期（发布 → 审查/签名 → 第二 Profile 安装 → 启用 → 真实 HTTP
运行 → 1.0.1 更新保留启用态 → 下架后已安装卡 `delisted` 且仍可运行 → 长回合撤销被中止 →
撤销版本不可再启用/分发），以及退出时零残留进程。

跨机器验收（macOS 创建者 + Windows 消费机 + 离线管理员）为 **`BLOCKED`**，见 §7。

## 1. 运行环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-25（本机时间；最终运行的审计时间戳为 2026-10-25T05:23Z） |
| 机器 | MacBook Pro（Mac16,8，Apple M4 Pro，24 GB） |
| OS | macOS 27.0.1（build 26A434）；`os.release()` 报告 `27.0.0` |
| Node | v22.23.2（本机默认；类型剥离默认开启，未加额外 flag） |
| 架构 | arm64 |
| 分支 / worktree | `feat/agent-packages-m2`，`.worktrees/m2-agent-packages` |
| 最终探针运行时的 HEAD | `c144a73383ded88bb183698bc1144d2a5f5ed681`（`fix: close final review findings`；探针报告同值） |
| 工作树状态 | 运行前 `git status --porcelain` 为空（干净树）：本文件的待更新改动先临时 `git stash`，运行结束后恢复。本证据文件的更新是紧跟代码提交的独立提交 |

## 2. 命令

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/.worktrees/m2-agent-packages
node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin-final.json
echo "EXIT=$?"
```

结果：`EXIT=0`。同一命令在本任务中共运行**六次**，计数与 §4 归档的最终运行一致：

1. 早期调试失败（参数/环境未就绪），无归档；
2. 早期调试失败，无归档；
3. 成功，HEAD `b952477a81`，**工作树含未提交的 Task 13 改动**——这是**中间运行**，其 JSON
   曾归档在 `cacba698fe` 的旧版本证据里；
4. 成功，提交 `cacba698fe` 的干净工作树，但**未归档 JSON**（仅当时口头记录，不作为证据）；
5. **中间运行**：提交 `13bb3fc90b` 的干净工作树，`EXIT=0`、`residualProcesses=0`、
   `auditLines=37`——它属于最终评审修复轮**之前**的代码树，已被第 6 次取代；
6. **最终运行**：提交 `c144a73383`（最终评审修复轮）的干净工作树，`EXIT=0`、
   `residualProcesses=0`、`auditLines=37`，原始 JSON 见 §4。

只有第 6 次是最终运行。第 3–6 次与它字段相同、运行期标识（submissionId/keyId/端口/
tempRoot）不同属正常。

## 3. 临时测试环境说明

本次运行的全部材料都在一次性临时目录里，运行结束即删除：

- `entries/`：空的旧 M-A0 条目目录；`data/`：服务端 `state.json`、`audit.jsonl`、
  `submissions/`、`packages/`；
- `keyring.json`：**每次运行现生成**的 Ed25519 公钥（slot 1）；私钥只写在同一临时目录的
  `signing-key.pem`（0600），从不打印、从不提交；
- `creator-profile/`、`consumer-profile/`、`third-profile/`：两个 Profile 加一个用于旧版本
  重放与下架安装负例的空 Profile；`workspace/`：HTTP fixture 子进程的工作目录；
- 三个 token 每次随机生成且两两不同；报告与日志里不出现 token 或私钥。

`tempRoot`（最终报告原值 `/var/folders/.../T/huaanwork-m2-accept-pHDRub`）在运行结束后已被
删除，因此不能用来重放；重放请重新执行 §2 的命令。

## 4. 最终探针原始 JSON（提交 `c144a73383`，干净工作树）

以下为 `/tmp/agent-package-m2-darwin-final.json` 原文（`node -e` 仅做 2 空格缩进，
字段值未改动）；探针报告的 `commit` 与运行 HEAD 一致。

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
  "commit": "c144a73383ded88bb183698bc1144d2a5f5ed681",
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
  "tempRoot": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-pHDRub",
  "steps": {
    "submitted": {
      "submissionId": "b931c45d-9300-4e58-b37d-7a52b76e78b5",
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
      "signedKeyId": "4ea41140aa78714c8cd4b4f0b9e1d058fcc7e563631f441b4b53a2fd442bad9d",
      "receipt": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-pHDRub/review-1.0.0/review.json",
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
      "keyId": "4ea41140aa78714c8cd4b4f0b9e1d058fcc7e563631f441b4b53a2fd442bad9d",
      "slot": 1,
      "version": "1.0.0",
      "digestFiles": 4,
      "note": "verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519."
    },
    "enabledAndHttpRan": {
      "version": "1.0.0",
      "httpPort": 63884,
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
      "requestId": "1be3d7c7-ed35-4789-8bef-70ce13be9be8",
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
      "httpPort": 63904,
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
        "submissionId": "0d1ca094-a67d-43c1-a49a-2b9a549cffef",
        "delistRequestId": "1be3d7c7-ed35-4789-8bef-70ce13be9be8"
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
          "revokedAt": "2026-10-25T05:23:49.319Z"
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
    "delistedVersionInstall": {
      "error": "目录中没有版本 1.0.1",
      "ok": true,
      "coveredBy": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts:602 「rejects a revoked version and reports the administrator reason」"
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
    "scannedProcesses": 815,
    "matches": [],
    "command": "ps -ax -o pid=,command=",
    "note": "Matches are processes whose command line references the throwaway temp root; the probe itself is excluded."
  },
  "verdict": "PASS",
  "exitCode": 0
}
```

### 4.1 中间运行归档（提交 `13bb3fc90b`，非最终证据）

以下是最终评审修复轮**之前**的中间运行原文（`/tmp/agent-package-m2-darwin-postcommit.json`），
保留以便对照；最终结论只取 §4。探针报告的 `commit` 与当时 HEAD 一致。

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
  "commit": "13bb3fc90bfccc99dacb0a98ae5331a0a6f9ca08",
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
  "tempRoot": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-qrIzBv",
  "steps": {
    "submitted": {
      "submissionId": "0e9b57dc-9991-407e-9dd2-278c0211fe98",
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
      "signedKeyId": "1febd0751b4e04368b046c6ef0066668913c64c8a3e070d7e97983db99fc0dce",
      "receipt": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-qrIzBv/review-1.0.0/review.json",
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
      "keyId": "1febd0751b4e04368b046c6ef0066668913c64c8a3e070d7e97983db99fc0dce",
      "slot": 1,
      "version": "1.0.0",
      "digestFiles": 4,
      "note": "verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519."
    },
    "enabledAndHttpRan": {
      "version": "1.0.0",
      "httpPort": 55379,
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
      "requestId": "cac50528-7352-4071-83a3-3fbaff6979f3",
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
      "httpPort": 55402,
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
        "submissionId": "fee3567e-1580-4f6c-b498-4c317cecc9ef",
        "delistRequestId": "cac50528-7352-4071-83a3-3fbaff6979f3"
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
          "revokedAt": "2026-10-25T04:31:26.574Z"
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
    "delistedVersionInstall": {
      "error": "目录中没有版本 1.0.1",
      "ok": true,
      "coveredBy": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts:602 「rejects a revoked version and reports the administrator reason」"
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
| `revokedEnableRejected` | 对已撤销版本：`setEnabled(true)` 被拒绝、stale 详情 dispatch 被拒绝、`assertRunnable` 被拒绝、卡片标 `broken`；四处文案都是撤销原因 `该版本已被管理员撤销：<原因>`（与签名失败的统一文案 `包校验失败，未安装或未运行。请联系管理员` 不同）。 |
| `residualProcesses` | 停止所有运行时后 `ps -ax -o pid=,command=` 扫描 815 个进程，命令行引用临时目录的进程为 0。 |

探针内的安全负例（同一次运行，全部为 `ok:true`）：

- 错误 token → HTTP 401 `{"error":"口令错误"}`；
- 未知 key → `包校验失败，未安装或未运行。请联系管理员`；
- 篡改 persona（复制一份后改动）→ 同一句失败文案；
- 旧版本重放（1.0.1 已发布时安装 1.0.0）→ `该版本不是目录中的最新版本，已拒绝安装`；
- 已下架版本安装（`delistedVersionInstall`：1.0.1 先被下架，**随后在本次负例之前已被撤销**）→
  `目录中没有版本 1.0.1`。这条只证明**下架/目录缺席使该版本从可安装集合中消失**；由于安装
  路径在版本选择阶段就拒绝，它**没有**走到撤销检查，因此不证明撤销专属文案。撤销专属的
  安装期文案 `该版本已被管理员撤销：<原因>` 由
  `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts:602`
  「rejects a revoked version and reports the administrator reason」钉住（探针 JSON 的
  `negatives.delistedVersionInstall.coveredBy` 同此指针）。“已安装副本被撤销禁用”由
  `revocationStoppedActiveTurn` / `revokedEnableRejected` 证明。

其余负例（未签名/夹带签名内容、额外文件、1025 个 0 字节条目、513 字节规范化路径、退休
key、降级、错误发布/管理 token、撤销与在途回合）由既有集成测试覆盖，文件见 JSON 的
`negatives.coveredByIntegrationTests`；`corepack yarn test` 本轮全绿（见 §6）。

## 6. 最终树门禁（代码提交 `c144a73383`）

五项命令**各自单独执行**并记录真实退出码；其中 `corepack yarn check` 的 15 个顶层步骤
全部执行，无删除、跳过或重排。其余条目是 `check` 链内部的步骤，未在链外重复运行。

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `corepack yarn check` | **0** | 15 个顶层步骤全部成功；`verify:aa` 并发 flake 未复现 |
| `corepack yarn check:desktop-variants` | 0 | 单独执行；stable↔beta 7、beta↔huaanwork 64、`oneSidedPrefixes` 6 |
| `node scripts/verify-layout.mjs` | 0 | 单独执行；`verify-layout: all Desktop workspaces including Next and upstream 1600d8a1e1 are consistent` |
| `corepack yarn typecheck` | 0 | 单独执行；11 个 workspace（含四个新 workspace） |
| `corepack yarn test` | 0 | 单独执行；15 个 workspace（含 `@huaanwork/catalog-signing`、`@huaanwork/agent-package-format`、`agent-catalog-server` 143 files、`agent-catalog-admin` 14 tests） |
| `corepack yarn check:layout` | 0 | `check` 链内执行；10 个子命令：`test:market-release`、`test:aa-release`、`check:bilingual-docs`、`check:architecture`、`check:vendored-runtime`、`check:desktop-variants`、`icons:check`、`verify-layout`、`test:gate-scripts`、`check:readme-versions` |
| `corepack yarn test:aa-connector` | 0 | `check` 链内执行 |
| `corepack yarn workspace dsh-community-fabric check` | 0 | `check` 链内执行 |
| `corepack yarn workspace dsh-community-market check` | 0 | `check` 链内执行 |
| `corepack yarn workspace dsh-plugin-desktop check` | 0 | `check` 链内执行 |
| `corepack yarn workspace dsh-plugin-desktop-beta check` | 0 | `check` 链内执行 |
| `corepack yarn workspace dsh-desktop-next check` | 0 | `check` 链内执行 |
| `corepack yarn workspace dsh-plugin-huaanwork check` | 0 | `check` 链内执行；含 M1 agent-package 测试与 `verify:aa` |
| `corepack yarn workspace market-server check` | 0 | `check` 链内执行；含 signing/envelope 测试 |
| `corepack yarn workspace update-server check` | 0 | `check` 链内执行 |
| `corepack yarn workspace @huaanwork/catalog-signing check` | 0 | `check` 链内执行 |
| `corepack yarn workspace @huaanwork/agent-package-format check` | 0 | `check` 链内执行 |
| `corepack yarn workspace agent-catalog-server check` | 0 | `check` 链内执行 |
| `corepack yarn workspace agent-catalog-admin check` | 0 | `check` 链内执行 |

`corepack yarn check` 在代码提交 `c144a73383` 之上、包含本证据文件最终内容的同一工作树上
执行，退出码 0；随后该工作树成为本证据文件的提交（与代码提交仅差文档）。没有删除、跳过
或重排任何门禁步骤，也没有出现 `verify:aa` 并发 flake。由于本文件的文字在 `check` 之后
还有补写，最终字节上另行重跑了两个文档型子门禁：`corepack yarn check:whitespace` 退出 0、
`corepack yarn check:bilingual-docs` 退出 0（`55 records and 110 documents are consistent`），
`node scripts/verify-layout.mjs` 在最终字节上复跑同样退出 0。

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

## 8. 补救轮最终运行（代码提交 `650e749af7`，2026-10-25）

### 8.1 这一轮改了什么（I-17）

探针（`dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs`）不再直接调用
`refreshInstalledCatalogPackageStatuses()` 和 `security.refreshRevocations()` 作为证据来源，
而是走产品真实的路由组合：

- 静态导入 `ROUTE_TABLE`（`src/huaanwork-host/routes.ts`）、`setAgentsDirectory` /
  `setAgentPackageHost`（`sessions.ts`）、`createAgentsHost`（`agents-host.ts`）、
  `readHuaanworkSettingsSync` / `writeHuaanworkSettings`（`settings.ts`）；
- consumer profile 先持久化 `huaanwork-settings.json`（`agents_host` / `agents_port` /
  `agents_catalog_token`），否则 `agent.packageRefresh` 内的 legacy 目录刷新会以
  「未配置」静默跳过而不报 `catalogError`；空的 endpoint 会被探针直接判失败（fail-closed）；
- 建 `legacyHost`（`onCatalogChange` 空实现）与包宿主的 `legacy` 回调，注入真实
  `security`，再构造 `RouteContext`（`runtimeCtx.huaanworkAgentCatalogSecurity` 指向真实
  security，`requestRestart` 返回 false）；
- `callPackageRpc(method)` 按 `ROUTE_TABLE.find(entry => entry.method === method)` 调用真实
  handler；
- **Step 7（下架）**：`agent.packageRefresh` 的返回卡片必须 `publishStatus:'delisted'`、
  `enabled:true`、无 `broken`；再用 `agent.packageList` 卡片交叉核对；`host.listLocal()`
  降为标注的 crossCheck；
- **Step 9（撤销）**：`agent.packageRefresh` 的返回卡片必须 `revoked.version === '1.0.1'`、
  `enabled:false`；`security.refreshRevocations()` 仅作标注的交叉核对，断言只读 RPC 结果；
- legacy 目录刷新若报 `catalogError`，探针不忽略：下架步骤直接失败，撤销步骤把值写进
  `steps.revocationStoppedActiveTurn.rpc.catalogError`；
- Task 7 的 redaction 保留：`requireCliOk` 的先扫描后引用、`report.error`、以及最终
  `redactReport()` 整份报告脱敏都未改动；本轮新增字段（`rpc` / `list` / `catalogRefresh` /
  `statusTransition`）不含命令输出以外的自由文本，且同样经过 `redactReport()`。

### 8.2 运行命令与一处**命令级偏差**（必须读）

本机 Node `v22.23.2`，`process.features.typescript === 'strip'`。

**命令 A（brief 字面命令，失败）**：

```bash
cd dsh-plugin-huaanwork
node --experimental-strip-types scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin-strip.json
echo "EXIT=$?"
```

结果：`EXIT=1`，在 **import 阶段**就失败，探针逻辑一行未执行：

```text
file:///.../dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:137
export class RouteError extends Error {
  constructor(public status: number, public code: string, message: string) {
                     ^^^^^^^^^^^^^^
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
```

原因是 Task 13 要求 import `routes.ts`，而该文件的 `RouteError` 用了 TypeScript
**参数属性**（`constructor(public status …)`），Node 的 strip-only 模式不支持；无 flag 的
`node`（`process.features.typescript === 'strip'`，Windows workflow 用的正是这种调用）同样
失败。这条失败**与探针断言无关**，也不是本轮遗漏接线。

**命令 B（实际产出本证据的运行）**：

```bash
cd dsh-plugin-huaanwork
node --experimental-transform-types scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin-final.json
echo "EXIT=$?"
```

结果：`EXIT=0`。`--experimental-transform-types` 只改变 TS 语法的转译方式（strip 之上增加
参数属性/enum 等转换），不改变探针任何逻辑或断言。

**未在本任务处置的收尾项（超出本任务 Files 白名单，留给 Task 14 裁定）**：二选一即可让
brief 的字面命令与 Windows workflow 重新可用——(a) 把 `RouteError` 改成可擦除语法（显式
字段 + 构造函数里赋值，约 4 行，行为与签名不变，`src/huaanwork-host/` 属单侧前缀，不占变体
白名单名额）；(b) 在运行命令与 `windows-agent-package-acceptance.yml` 的 M2 step 上加
`--experimental-transform-types`。本轮**没有**改这两个白名单外文件。

> **收尾（2026-10-25 fix round 1，裁定 R-T13-1）**：采纳**选项 (b)**。探针 usage 注释、
> runbook（`docs/huaanwork-agent-packages-m2.md` §14）、workflow 的 M2 step 与本节之后的
> 运行统一改用 `--experimental-transform-types`；`RouteError` 与产品源码一行未动。改用该
> flag 后的权威运行见 **§9**，§8.2 命令 B 保留为同一条命令的首次成功记录。

### 8.3 运行环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-25（撤销审计时间戳 `2026-10-25T12:54:06.844Z`） |
| HEAD | `650e749af7f8445b37c26c49df4feaf33e267f92`（探针报告 `commit` 同值） |
| 工作树 | 已跟踪文件干净；仅有两个未被本任务提交的未跟踪规划/评审文档（`docs/superpowers/...`） |
| 机器 / OS / Node | MacBook-Pro-14.local（arm64）/ Darwin 27.0.0 / Node v22.23.2 |
| 运行命令 | §8.2 命令 B（`--experimental-transform-types`） |

### 8.4 关键字段（RPC 证据）

| 字段 | 值 / 证据源 |
| --- | --- |
| `delistedStatusVisible.primary` | `agent.packageRefresh` |
| `delistedStatusVisible.crossCheck` | `host.listLocal`（只作交叉核对） |
| `delistedStatusVisible.rpc.card` | `publishStatus:'delisted'`、`enabled:true`、无 `broken`、`version:'1.0.1'`、`latestVersion:'1.0.0'` |
| `delistedStatusVisible.list.card` | `agent.packageList` 返回同一卡片（`publishStatus:'delisted'`） |
| `delistedStatusVisible.statusTransition` | `before:'installed'` → `after:'delisted'`，`via:'agent.packageRefresh'` |
| `delistedStatusVisible.catalogRefresh` | `route:'agent.packageRefresh → getAgentsDirectory().refresh()'`、`catalogError:null`、`legacyItems:0` |
| `revocationStoppedActiveTurn.primary` | `agent.packageRefresh` |
| `revocationStoppedActiveTurn.crossCheck` | `security.refreshRevocations`（只作交叉核对） |
| `revocationStoppedActiveTurn.rpc.card` | `revoked.version:'1.0.1'`、`enabled:false`、`broken.reason` 与撤销文案一致、`catalogError:null` |
| `revocationStoppedActiveTurn.warnings` / `crossCheckWarning` | 均为 `null` |
| `revokedEnableRejected` | `primary:'agent.packageRefresh'`、`crossCheck:'host.listLocal'`，`cardBroken` 与 RPC 卡片的 `broken.reason` 逐字相同（探针额外钉了两通道原因一致性） |
| `residualProcesses` | `0`（`cleanup.scannedProcesses:819`，`matches:[]`） |
| `verdict` / `exitCode` | `PASS` / `0` |

### 8.5 进程清单

brief 的取样命令 `ps -ax -o pid=,command= | grep -F "$(mktemp -u /tmp/agent-package-m2-)"`
命中的唯一进程是**执行该 grep 的 shell 自身**（它的命令行里包含该字面路径），没有探针或
fixture 进程。按真实临时目录前缀复扫：

```text
ps -ax -o pid=,command= | grep -F "huaanwork-m2-accept-" | grep -v "grep -F"
（无输出）
```

探针自身的扫描结果：`scannedProcesses:819`、`matches:[]`、命令
`ps -ax -o pid=,command=`。

### 8.6 原始 JSON（`/tmp/agent-package-m2-darwin-final.json`，未改动字段值）

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
  "commit": "650e749af7f8445b37c26c49df4feaf33e267f92",
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
  "tempRoot": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-eyCRfW",
  "steps": {
    "submitted": {
      "submissionId": "a9d08f4a-5ef0-4c7c-bed6-29d4a1312d35",
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
      "signedKeyId": "bde3722a11e7dc6d815f3a09138273f9d7bacc79f66647676b150b0020eaba0f",
      "receipt": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-eyCRfW/review-1.0.0/review.json",
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
      "keyId": "bde3722a11e7dc6d815f3a09138273f9d7bacc79f66647676b150b0020eaba0f",
      "slot": 1,
      "version": "1.0.0",
      "digestFiles": 4,
      "note": "verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519."
    },
    "enabledAndHttpRan": {
      "version": "1.0.0",
      "httpPort": 51119,
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
      "requestId": "ad753787-7d3e-4c39-9809-f2991289cabb",
      "publishStatus": "delisted",
      "enabled": true,
      "primary": "agent.packageRefresh",
      "crossCheck": "host.listLocal",
      "rpc": {
        "method": "agent.packageRefresh",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": true,
          "publishStatus": "delisted",
          "latestVersion": "1.0.0",
          "updateAvailable": false
        },
        "catalogError": null,
        "revocationWarning": null
      },
      "list": {
        "method": "agent.packageList",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": true,
          "publishStatus": "delisted",
          "latestVersion": "1.0.0",
          "updateAvailable": false
        }
      },
      "catalogRefresh": {
        "route": "agent.packageRefresh → getAgentsDirectory().refresh()",
        "catalogError": null,
        "legacyItems": 0
      },
      "statusTransition": {
        "before": "installed",
        "after": "delisted",
        "via": "agent.packageRefresh"
      }
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
      "primary": "agent.packageRefresh",
      "crossCheck": "security.refreshRevocations",
      "warnings": null,
      "crossCheckWarning": null,
      "rpc": {
        "method": "agent.packageRefresh",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": false,
          "publishStatus": "delisted",
          "revoked": {
            "slug": "m2-acceptance-agent",
            "version": "1.0.1",
            "reason": "M2 验收:撤销当前版本",
            "revokedAt": "2026-10-25T12:54:06.844Z"
          },
          "broken": {
            "reason": "该版本已被管理员撤销：M2 验收:撤销当前版本"
          },
          "latestVersion": "1.0.0",
          "updateAvailable": false
        },
        "catalogError": null
      },
      "session": "m2-acceptance-session-3",
      "httpPort": 51145,
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
      "primary": "agent.packageRefresh",
      "crossCheck": "host.listLocal",
      "cardBroken": "该版本已被管理员撤销：M2 验收:撤销当前版本"
    },
    "finalState": {
      "creator": {
        "source": "local",
        "enabled": true,
        "installedVersion": "1.0.1",
        "publishStatus": "published",
        "publishedVersion": "1.0.1",
        "submissionId": "5021251c-7d70-43f8-8ecf-174e75e859ea",
        "delistRequestId": "ad753787-7d3e-4c39-9809-f2991289cabb"
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
          "revokedAt": "2026-10-25T12:54:06.844Z"
        }
      },
      "auditLines": 44
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
    "delistedVersionInstall": {
      "error": "目录中没有版本 1.0.1",
      "ok": true,
      "coveredBy": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts:602 「rejects a revoked version and reports the administrator reason」"
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

### 8.7 与 `c144a73383` 轮的差异

- `delistedStatusVisible`：证据源从 `refreshInstalledCatalogPackageStatuses()` 的
  `changed:true` 换成真实 `agent.packageRefresh` 的返回卡片；新增 `rpc` / `list`（`agent.packageList`
  交叉核对）/ `catalogRefresh` / `statusTransition` 字段，`crossCheck:'host.listLocal'` 明示降级关系。
- `revocationStoppedActiveTurn`：证据源从直接 `security.refreshRevocations()` 换成真实
  `agent.packageRefresh`（其最后一相就是撤销刷新）；`security.refreshRevocations()` 保留为
  `crossCheck:'security.refreshRevocations'`，并另记 `crossCheckWarning`。
- `revokedEnableRejected`：新增 `primary` / `crossCheck` 标注，并断言 RPC 卡片与
  `host.listLocal()` 的 `broken.reason` 一致。
- `auditLines` 44、`residualProcesses` 0、失败文案与负例集合均与上一轮一致（每次运行的
  `submissionId` / `keyId` / 端口 / `tempRoot` 不同属正常）。
- Windows：本轮环境**可以** push 并触发 GHA，已实际运行；M1 Windows 探针在该提交上
  PASS，M2 step 因同一 strip-only import 问题失败。详见
  `2026-10-24-agent-package-m2-windows-acceptance.md` §8。跨机器验收仍为 `BLOCKED`（没有
  第二台 Windows 机器）。

## 9. 权威运行：`--experimental-transform-types`（fix round 1，2026-10-25）

本节是**当前权威**的 macOS 证据。§8 保留为同一份探针代码的首次成功运行（手工加
`--experimental-transform-types` 绕开 strip-only）；§8.2 命令 A（strip-only 失败）同样保留，
它是本轮换 flag 的依据。

### 9.1 这一轮改了什么

裁定 **R-T13-1** 选择「加 flag」而不是重构 `RouteError`：

- `dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs` 的文件头
  usage 注释与 `usage()` 打印的用法行改为 `node --experimental-transform-types …`；
- `.github/workflows/windows-agent-package-acceptance.yml` 的 **M2 step** 改用
  `node --experimental-transform-types`（M1 step 保持无 flag 的 `node`，它不 import
  `routes.ts`）；
- `docs/huaanwork-agent-packages-m2.md` §14 的两条探针命令同步加上该 flag；
- 探针的 **CLI 子进程**仍是 `--experimental-strip-types`（admin CLI 不 import `routes.ts`，
  不受影响），产品源码、路由接线、断言逻辑**一行未改**。

`--experimental-transform-types` 只改变 TS 语法的转译方式（在 strip 之上增加参数属性、enum
等转换），因此除 import 可行性外，本运行与 §8.6 的行为等价。

### 9.2 命令与退出码

```bash
cd dsh-plugin-huaanwork
node --experimental-transform-types scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin-fix1.json
echo "EXIT=$?"
```

结果：**`EXIT=0`**。stderr 有一条
`ExperimentalWarning: Transform Types is an experimental feature and might change at any time`
—— Node `v22.23.2` 上该 flag 仍标注实验性；它只影响 TS 转译，不进入报告 JSON。

### 9.3 运行环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-25（撤销审计时间戳 `2026-10-25T13:30:16.723Z`） |
| HEAD | `f2eebef933cd3ab425ec55c2d8b9fecf14d31984`（探针报告 `commit` 同值；相对代码提交 `650e749af7` 只多了上一轮的证据提交） |
| 工作树 | 运行前把本轮三处改动（探针注释、workflow、runbook）`git stash`，**已跟踪树干净**；运行后 `git stash pop` 恢复。两份未跟踪的规划/评审文档未提交、未参与运行 |
| 机器 / OS / Node | MacBook-Pro-14.local（arm64）/ Darwin 27.0.0 / Node v22.23.2（`process.features.typescript === 'strip'`，必需显式 flag） |
| 运行命令 | `node --experimental-transform-types … --out /tmp/agent-package-m2-darwin-fix1.json` |

### 9.4 关键字段（RPC 证据）

| 字段 | 值 / 证据源 |
| --- | --- |
| 11 个布尔字段 | 全 `true`（`submitted` … `revokedEnableRejected`） |
| `delistedStatusVisible.primary` / `crossCheck` | `agent.packageRefresh` / `host.listLocal`（断言只读 RPC） |
| `delistedStatusVisible.rpc.card` | `publishStatus:'delisted'`、`enabled:true`、无 `broken`、`version:'1.0.1'`、`latestVersion:'1.0.0'` |
| `delistedStatusVisible.list.card` | `agent.packageList` 返回同一卡片 |
| `delistedStatusVisible.catalogRefresh` | `catalogError:null`、`legacyItems:0` |
| `revocationStoppedActiveTurn.primary` / `crossCheck` | `agent.packageRefresh` / `security.refreshRevocations` |
| `revocationStoppedActiveTurn.rpc.card` | `revoked.version:'1.0.1'`、`enabled:false`、`broken.reason` 与撤销文案一致、`catalogError:null` |
| `warnings` / `crossCheckWarning` | 均为 `null` |
| `revokedEnableRejected.cardBroken` | 与 RPC 卡片 `broken.reason` 逐字相同 |
| `residualProcesses` | `0`（`cleanup.scannedProcesses:821`，`matches:[]`） |
| `verdict` / `exitCode` | `PASS` / `0` |

### 9.5 进程清单

按真实临时目录前缀复扫（探针已自行回收全部子进程）：

```text
ps -ax -o pid=,command= | grep -F "huaanwork-m2-accept-" | grep -v "grep -F"
（无输出）
ps -ax -o pid=,command= | wc -l
     820
```

探针自身的扫描：`cleanup.command = "ps -ax -o pid=,command="`、`scannedProcesses:821`、
`matches:[]`，与人工复扫一致。brief 里的
`grep -F "$(mktemp -u /tmp/agent-package-m2-)"` 仍只命中执行它的 shell 自身，故沿用前缀复扫。

### 9.6 原始 JSON（`/tmp/agent-package-m2-darwin-fix1.json`，未改动字段值）

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
  "commit": "f2eebef933cd3ab425ec55c2d8b9fecf14d31984",
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
  "tempRoot": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-LmPbrk",
  "steps": {
    "submitted": {
      "submissionId": "496f5783-10f8-47d0-a3d0-cd9cd9355bc9",
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
      "signedKeyId": "3387f071e46dfb04a36c347b3ab54d7da9521a847cf543fa3cb7b4a4e45bb86f",
      "receipt": "/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T/huaanwork-m2-accept-LmPbrk/review-1.0.0/review.json",
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
      "keyId": "3387f071e46dfb04a36c347b3ab54d7da9521a847cf543fa3cb7b4a4e45bb86f",
      "slot": 1,
      "version": "1.0.0",
      "digestFiles": 4,
      "note": "verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519."
    },
    "enabledAndHttpRan": {
      "version": "1.0.0",
      "httpPort": 54617,
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
      "requestId": "d580f9e2-5718-4103-a0df-2d8abd27fbb1",
      "publishStatus": "delisted",
      "enabled": true,
      "primary": "agent.packageRefresh",
      "crossCheck": "host.listLocal",
      "rpc": {
        "method": "agent.packageRefresh",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": true,
          "publishStatus": "delisted",
          "latestVersion": "1.0.0",
          "updateAvailable": false
        },
        "catalogError": null,
        "revocationWarning": null
      },
      "list": {
        "method": "agent.packageList",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": true,
          "publishStatus": "delisted",
          "latestVersion": "1.0.0",
          "updateAvailable": false
        }
      },
      "catalogRefresh": {
        "route": "agent.packageRefresh → getAgentsDirectory().refresh()",
        "catalogError": null,
        "legacyItems": 0
      },
      "statusTransition": {
        "before": "installed",
        "after": "delisted",
        "via": "agent.packageRefresh"
      }
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
      "primary": "agent.packageRefresh",
      "crossCheck": "security.refreshRevocations",
      "warnings": null,
      "crossCheckWarning": null,
      "rpc": {
        "method": "agent.packageRefresh",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": false,
          "publishStatus": "delisted",
          "revoked": {
            "slug": "m2-acceptance-agent",
            "version": "1.0.1",
            "reason": "M2 验收:撤销当前版本",
            "revokedAt": "2026-10-25T13:30:16.723Z"
          },
          "broken": {
            "reason": "该版本已被管理员撤销：M2 验收:撤销当前版本"
          },
          "latestVersion": "1.0.0",
          "updateAvailable": false
        },
        "catalogError": null
      },
      "session": "m2-acceptance-session-3",
      "httpPort": 54639,
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
      "primary": "agent.packageRefresh",
      "crossCheck": "host.listLocal",
      "cardBroken": "该版本已被管理员撤销：M2 验收:撤销当前版本"
    },
    "finalState": {
      "creator": {
        "source": "local",
        "enabled": true,
        "installedVersion": "1.0.1",
        "publishStatus": "published",
        "publishedVersion": "1.0.1",
        "submissionId": "7b05540d-600e-454d-995c-d5fa4b6730f2",
        "delistRequestId": "d580f9e2-5718-4103-a0df-2d8abd27fbb1"
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
          "revokedAt": "2026-10-25T13:30:16.723Z"
        }
      },
      "auditLines": 44
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
    "delistedVersionInstall": {
      "error": "目录中没有版本 1.0.1",
      "ok": true,
      "coveredBy": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts:602 「rejects a revoked version and reports the administrator reason」"
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
    "scannedProcesses": 821,
    "matches": [],
    "command": "ps -ax -o pid=,command=",
    "note": "Matches are processes whose command line references the throwaway temp root; the probe itself is excluded."
  },
  "verdict": "PASS",
  "exitCode": 0
}
```

### 9.7 与 §8 的差异

- **HEAD**：`f2eebef933`（上一轮的证据提交）vs `650e749af7`（探针代码提交）。两者之间只
  有一份文档提交，探针逻辑逐字相同。
- **随机量不同属正常**：`submissionId`（`496f5783…` / `7b05540d…`）、`signedKeyId`、
  `requestId`、`tempRoot`、各端口、`revokedAt` 每次运行都变。
- **稳定量一致**：11 个布尔、`negative` 集合与文案、`auditLines:44`、`residualProcesses:0`、
  `cleanup.matches:[]`；`cleanup.scannedProcesses` 由 819 变为 821（系统进程数波动）。
- **本轮未重跑** `corepack yarn check`（Task 14 收口门禁）；改动只涉及探针 usage 注释、
  workflow 的 M2 step 与文档命令文本，未触碰产品源码。

---

## 10. 最终代码 HEAD 的复跑（final fix wave 之后）

§9 的探针来源是 `f2eebef933`；最终 fix wave 在 `b2821f27f7` 修改了 publish sidecar 与
audit reconciliation，并在 `68580abfca` 更新文档。按〈最终门槛〉“验收须在最终 HEAD 通过”
的要求，本节是最终代码 HEAD 的 canonical 运行。

| 项 | 值 |
| --- | --- |
| 代码 HEAD | `68580abfca5160a2d2e9ea6e96ea636f81585089` |
| 命令 | `node --experimental-transform-types scripts/huaanwork-agent-package-m2-acceptance.mjs --platform darwin --out /tmp/agent-package-m2-darwin-finalfix.json` |
| 退出码 | **0** |
| verdict | **PASS** |
| 11 个字段 | 全部 `true` |
| `residualProcesses` | `0`；`cleanup.scannedProcesses: 814`，`cleanup.matches: []` |
| 下架卡片 | `primary: agent.packageRefresh`；`publishStatus: delisted`，`enabled: true`，`statusTransition.installed → delisted`，`catalogError: null`，`revocationWarning: null` |
| 撤销卡片 | `primary: agent.packageRefresh`；`enabled: false`，`revoked.version: 1.0.1`，`broken.reason: 该版本已被管理员撤销：M2 验收:撤销当前版本`；`activationDisposed: true`，`portClosed: true` |
| 原始 JSON | `docs/evidence/2026-10-25-agent-package-m2-darwin-finalfix.json`（完整 probe 输出，10,208 字节） |

最终代码 HEAD 的 `corepack yarn check` 在同一提交上以 exit 0 通过（Task 14 之后的
final fix wave 复跑）；本节的复跑证明 final fix wave 没有破坏真实发布/刷新/下架/撤销链路。

