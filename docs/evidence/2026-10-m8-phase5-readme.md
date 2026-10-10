# Phase 5 README version guard — Task 5.2

Recorded on `sync/upstream-2.0.x` in `HuaAnWork-Desktop-sync`. Counts below are as-of `9d442bfeff`. They were read on parent `5c0815d23f`. `9d442bfeff` adds only this document.

## Guard reading

`package.json` maps root `check:readme-versions` to `node scripts/verify-readme-versions.mjs`. The script under that name is `scripts/verify-readme-versions.mjs`.

The 4/1/4 rule is the scope registered for R-M7-4. It still holds, and the out-of-scope marks are the same four paths registered in `e8bd0c24b4` (`git diff e8bd0c24b4 HEAD` does not touch `outOfScopeRegistered` or those paths).

| Count | What it is |
|---|---|
| 4 | Hardcoded artifact version strings. `dsh-plugin-huaanwork/README.md` and `README.zh.md` each contain `HuaAnWork-0.1.0-x64-Setup.exe` and `HuaAnWork-0.1.0-x64-Portable.zip` (lines 245 and 257 in both files). |
| 1 | Scoped package: `dsh-plugin-huaanwork`. `README_VERSION_SCOPES` has length 1. Authority is that package's own `package.json` `"version": "0.1.0"`. All four strings match it. |
| 4 | READMEs left out of scope (M28), unchanged: `dsh-plugin-desktop/README.md`, `dsh-plugin-desktop/README.zh.md`, `dsh-plugin-desktop-beta/README.md`, `dsh-plugin-desktop-beta/README.zh.md`. |

Root `package.json` has no `version` field. The guard does not compare against a root version.

## Command

From `HuaAnWork-Desktop-sync`, parent `5c0815d23f`:

```bash
corepack yarn check:readme-versions
```

Exit 0. The script printed one line:

```
verify-readme-versions: 4 hardcoded artifact version string(s) in 1 scoped package(s) (dsh-plugin-huaanwork) match their own package.json; 4 README(s) out of scope (M28): dsh-plugin-desktop/README.md, dsh-plugin-desktop/README.zh.md, dsh-plugin-desktop-beta/README.md, dsh-plugin-desktop-beta/README.zh.md
```

No README was edited. The guard was already green, so there was no in-scope drift to fix.

## Stable and beta strings

Those four READMEs stay out of scope. Their artifact strings were not rewritten by the upstream sync. `dsh-plugin-desktop` `package.json` is `2.0.17`, and both READMEs still name `DSH-Desktop-2.0.5-x64-Setup.exe` and `DSH-Desktop-2.0.5-x64-Portable.zip` (lines 237 and 249). `dsh-plugin-desktop-beta` `package.json` is `2.0.17-beta.1`, and both READMEs still name `DSH-Desktop-Beta-2.0.5-beta.2-x64-Setup.exe` and `DSH-Desktop-Beta-2.0.5-beta.2-x64-Portable.zip` (lines 237 and 249). That is the same README pair M7 recorded (`2.0.5` / `2.0.5-beta.2`). The out-of-scope marks were not changed.
