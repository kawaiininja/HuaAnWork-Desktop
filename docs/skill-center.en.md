# Intranet Skill Center Deployment and Operations

This document explains how to deploy the shared skill catalog (the skill center) on the organization's intranet, and how desktop clients connect, publish, and back it up. The catalog is served by the existing `agent-catalog-server` process: it shares the address, port, read token, and audit infrastructure with the agent catalog, but owns separate storage, separate skill upload tokens, and a separate `/v1/skills` API.

## 1. Server configuration

Skill uploads use a dedicated `AGENT_CATALOG_SKILL_UPLOADERS` map. Do **not** reuse the agent-package publish token:

```bash
# Operators generate each uploader's token first (example only; never commit real tokens)
openssl rand -hex 32   # alice's skill upload token
openssl rand -hex 32   # bob's skill upload token

AGENT_CATALOG_SKILL_UPLOADERS="{\"alice\":\"${ALICE_SKILL_TOKEN}\",\"bob\":\"${BOB_SKILL_TOKEN}\"}"
```

Startup validation is fail-closed:

- A publisher id must match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Every token is at least 32 characters, distinct from the others, and distinct from the read / publish / admin tokens.
- Leaving the variable unset disables skill uploads; browsing, downloading, local skills, and `/` invocation keep working.
- Validation failures refuse startup; error messages never echo token values.

Browsing and downloading reuse the existing `AGENT_CATALOG_TOKEN` (read token). The two surfaces never grant each other's permissions: a skill upload token cannot submit or approve agent packages, and the agent publish token cannot publish skills.

## 2. Client settings

In the desktop app, open **Settings → Quality → Shared machine configuration**:

- Host / port: the same as the agent catalog.
- Access token: the read token.
- Skill upload token: this user's own skill upload token (empty disables upload only).

Settings are re-read on every request, so saving takes effect without restarting the Host. The client refuses public hosts and cross-origin redirects.

## 3. API summary

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/skills?cursor=&limit=` | read: latest revision per name (limit default 100, range 1–100) |
| GET | `/v1/skills/{name}/{revision}` | read: exact revision metadata |
| GET | `/v1/skills/{name}/{revision}/archive` | read: the exact revision `.tar.gz` |
| POST | `/v1/skills/{name}` | skill-publish: upload publishes immediately |

The upload body is a raw `application/gzip` archive: at most 5 MiB compressed and 5 MiB of content, at most 256 entries, and paths of at most 512 UTF-8 bytes. The server validates the archive structure, name, and digest, then publishes at once. There is **no review queue, no signing, and no keyring verification**; the digest proves integrity only, not publisher identity. Retrying a first publish with the same name and digest is idempotent; updates must carry `X-Skill-Expected-Revision`, and a non-owner update answers `skill-name-conflict`.

## 4. Storage, backup, and recovery

Skill state is independent from the agent catalog:

- `<dataDir>/skills/state.json`: revisions, owner, publisher, and archive paths.
- `<dataDir>/skills/archives/<name>/<revision>.tar.gz`: immutable archive copies.
- `<dataDir>/skills/audit.jsonl` and `audit-intents.jsonl`: the skill-only audit journal.

**Back up the whole `<dataDir>/skills/` directory** (archives and audit included), and keep it separately from `<dataDir>/state.json`. Restore it as a unit; never restore `state.json` without its archives.

A corrupt state document refuses startup (exit code 1) instead of silently resetting to an empty catalog. Skill state and the agent catalog share one process: a corrupt skill state makes the agent catalog unavailable too. That coupled fail-closed behavior is expected for the shared startup path; there is no skill-only degradation.

## 5. Token rotation

1. Generate new tokens and update `AGENT_CATALOG_SKILL_UPLOADERS` (keep the old entries until every user has switched, or replace them outright to force rotation).
2. Restart `agent-catalog-server`.
3. Tell users to update the "skill upload token" in their desktop settings. Old tokens stop working immediately; already published content is unaffected.

## 6. Known boundaries

- The catalog is an intranet snapshot store, not a public market, and it never deletes local copies: if a catalog entry disappears or is withdrawn, the local skill is kept by default.
- Download and upload are both copies; upload never changes local enablement, and downloaded copies start disabled.
- The desktop only isolates the global `$DSH_AGENTS_HOME/skills` (usually `~/.agents/skills`) scan; project workspaces' `.dsh/skills`, `.agents/skills`, and `$DSH_HOME/skills` remain upstream provider scan roots.
