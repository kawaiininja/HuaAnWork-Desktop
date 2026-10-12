# code-review 内置技能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `代码审查智能体` 的审查能力以**内置技能**装进 HuaAnWork,对话里 `/code-review` 可用,且模型在用户说「review 一下」时能自己挑到它。

**Architecture:** 目录包形态 `dsh-plugin-huaanwork/skills/code-review/SKILL.md`,与 21 个既有目录型内置技能同构。运行时由 `resolveBundledSkillsRoot`(`src/huaanwork-guardrails/skills.ts:334-343`)解析到包内 `skills/`,`scanBundledSkillEntries` 每次调用 `readdirSync` 实读磁盘;启用后经 `registerBundledSkill`(`:418-438`)注册进 `ctx.skills`。无新进程、无端口、无构建改动(`package.json` 的 `files` 已含 `"skills/"`)。

**Tech Stack:** Markdown(SKILL.md 目录包约定)+ vitest 断言更新。

**Spec:** `docs/superpowers/specs/2026-10-12-code-review-skill-design.md`

## Global Constraints

- 技能名必须匹配 `SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`(`skills.ts:270`)→ 固定为 `code-review`;与既有 23 个内置技能无撞名(`takenNames`,`skills-host.ts:169-173`)。
- frontmatter 必须含非空 `name` 与 `description`,否则 `listBundledSkills` 静默跳过(`skills.ts:243`)。
- 限额:`description` ≤ 1024 字符、正文 ≤ 64 KiB(`skills-host.ts:154-156`)。本技能实测 204 字符 / 2827 字节。
- 变体守卫白名单成本 **0**:守卫只比 `dirs: ['src','scripts']`(`scripts/verify-desktop-variants.mjs:65`、`:97`),`skills/` 与 `tests/` 都不在其中,且 stable/beta 两包均无 `skills/` 目录。**但注意:守卫在 HEAD 上本就红**(与本任务无关,详见 Task 3 Step 3),不要用「守卫绿」当本任务的出口判据。
- **两处测试硬钉必须同改**,否则 `vitest` 红:`skills.spec.ts:435-453`(标题 + `deepEqual` 全量名单)与 `:457`(`names.length`)。
- 内置技能**默认禁用**(`routes.ts:333` 的 `enabled: SYSTEM_SKILLS.has(name) || toggles[name] === true`,而 `SYSTEM_SKILLS` 只有 `explore`/`test-fix`)⇒ 装完必须在技能中心打开开关。
- 不动 `代码审查智能体/` 目录里的任何文件。
- 工作区有大量与本任务无关的既有删除项 ⇒ `git add` 只加下面列明的路径,**不用 `-A`**。

---

### Task 1: 更新钉住内置技能清单的两处断言

**Files:**
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts:435-457`

**Interfaces:**
- Consumes: 无(本 Task 是 TDD 的红阶段)。
- Produces: 一个**当前为红**的断言集,期望名单含 `"code-review"`、总数 24;Task 2 落文件后转绿。

- [x] **Step 1: 记录改前基线**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/skills.spec.ts`
Expected: `Test Files  1 passed (1)` / `Tests  24 passed (24)`(实测 20ms)

- [x] **Step 2: 把 23 改成 24 并插入 code-review**

`skills.spec.ts:435` 的测试标题 `exactly 23 names` → `exactly 24 names`;`:440-449` 的 `assert.deepEqual` 名单按字母序插入 `"code-review"`(位于 `"brainstorming"` 与 `"darwin-skill"` 之间);在 `:452` 之后补一条:

```ts
  assert.equal(byName.get("code-review"), "bundle");
```

`:457` 的 `assert.equal(names.length, 23)` → `assert.equal(names.length, 24)`。

- [x] **Step 3: 跑红,确认失败面恰好是这两条**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/skills.spec.ts`
Expected: `⎯ Failed Tests 2 ⎯`,失败项为 `× scanBundledSkillEntries covers flat and directory forms, exactly 24 names` 与 `× listBundledSkills covers directory-form skills`;首条报 `AssertionError: Expected values to be strictly deep-equal:` 且 diff 含 `- 'code-review'`。**其余 22 条必须仍绿**——若有第三条红,说明动到了名单之外的东西,回退重做。

### Task 2: 落地 SKILL.md

**Files:**
- Create: `dsh-plugin-huaanwork/skills/code-review/SKILL.md`

**Interfaces:**
- Consumes: spec〈SKILL.md 最终内容〉一节(逐字)。
- Produces: 第 24 个内置技能 `code-review`(`kind: "bundle"`),供 Task 3 的门禁与 Task 4 的界面验证消费。

- [x] **Step 1: 创建目录并写入文件**

创建 `skills/code-review/`,写入 spec〈SKILL.md 最终内容〉围栏里的内容(逐字,含 frontmatter 三条横线在文件第一行)。

- [x] **Step 2: 无头验证解析与限额**

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork
node -e "
const fs=require('fs');
const raw=fs.readFileSync('skills/code-review/SKILL.md','utf8');
const m=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)\$/);
if(!m) throw new Error('frontmatter 边界不匹配');
const fm={};
for(const l of m[1].split('\n')){ if(/^[ \t]/.test(l))continue; const i=l.indexOf(':'); if(i===-1)continue; fm[l.slice(0,i).trim()]=l.slice(i+1).trim(); }
if(!/^[a-z0-9]+(?:-[a-z0-9]+)*\$/.test(fm.name)) throw new Error('name 不合规: '+fm.name);
if(!fm.description) throw new Error('description 缺失');
console.log('keys:', Object.keys(fm).join(','));
console.log('desc chars:', [...fm.description].length, '(<=1024)');
console.log('body bytes:', Buffer.byteLength(m[2].trim(),'utf8'), '(<=65536)');
"
```

Expected(实测):
```
keys: name,description,argument-hint
desc chars: 204 (<=1024)
body bytes: 2827 (<=65536)
```
任何 throw 即失败。注:`argument-hint` 不在 `MANAGED_KEYS`(`skills.ts:272`)⇒ 落进 `extraLines` 被保留但**不生效**;保留它是为了与同目录 `investigate/SKILL.md` 的先例一致,不要指望界面显示参数提示。

- [x] **Step 3: 跑绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/skills-host.spec.ts tests/client-huaanwork/skillsLogic.spec.ts`
Expected: `Test Files  3 passed (3)` / `Tests  43 passed (43)`(实测 24 + 14 + 5)

### Task 3: 门禁

**Files:** 无(纯验证)

**Interfaces:**
- Consumes: Task 1/2 的产物。
- Produces: 「可提交」判定,供 Task 5。

- [x] **Step 1: typecheck**

Run: `corepack yarn workspace dsh-plugin-huaanwork typecheck`
Expected: 退出码 `0`,无输出(实测 `TYPECHECK_EXIT=0`)。该脚本串 5 个 `tsc --noEmit`(`tsconfig.json` / `.client` / `.native-ui` / `.tests` / `.tests.client`)。

- [x] **Step 2: 确认运行中的编译产物已能看到新技能(无需重建/重启)**

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork
node --input-type=module -e "
const m = await import('./lib/skills-4JUbFoUH.js')
for (const k of Object.keys(m)) {
  const v = m[k]
  if (typeof v !== 'function' || v.length > 0) continue
  try { const r = v()
    if (Array.isArray(r) && r.length > 10 && r[0] && typeof r[0].name === 'string')
      console.log('总数', r.length, '| code-review', r.some(s => s.name === 'code-review') ? 'YES' : 'NO')
  } catch {}
}
"
```

Expected(实测):`总数 24 | code-review YES`

依据:`lib/` 是应用当前加载的编译产物(pid 49732 跑 `lib/main.js`),`BUNDLED_SKILLS_ROOT` 在模块加载期由 `resolveBundledSkillsRoot` 定为 `<pkg>/skills`,而 `scanBundledSkillEntries` 每次调用都 `readdirSync` ⇒ **新目录即时可见,`yarn dev` 重建与重启应用都不需要**。若 `lib/` 的 chunk 名不是 `skills-4JUbFoUH.js`(重新构建过就会变),先 `grep -l listBundledSkills lib/*.js` 取当前名。

- [ ] **Step 3: 记录变体守卫的既有红(不属本任务,不得绕过)**

Run: `corepack yarn check:desktop-variants`
Expected(2026-10-12 实测):`# tests 11 / # pass 10 / # fail 1`,唯一失败项是 `not ok 5 - verify-desktop-variants: 当前仓库实跑全绿,三通道摘要在位`,报 `Desktop variant source drift is not declared: - [beta↔huaanwork] src/electron-shell-generation.ts`。

**归因(已实测,与本任务无关)**:提交 `f9fd375243`(2026-10-11,即 spec 提交的前一笔)给 `dsh-plugin-huaanwork/src/electron-shell-generation.ts` 加了 **5 行**(`renderer.setZoomLevel(0)` 及其 4 行注释),既未同步 `dsh-plugin-desktop-beta` 侧、也未登记进 `allowedDifferences`(全文件 `grep -c electron-shell-generation scripts/verify-desktop-variants.mjs` = **0**)。同提交对 `src/profile.ts` 的 7 行改动**不触发**,因为该文件已在白名单内。两个 `electron-shell-generation.ts` 在工作树里都是干净的 ⇒ 该红在 HEAD 上即成立,与本任务的 4 个路径(全在 `skills/`、`tests/`、`docs/` 下)无交集。

**处置**:本任务**不修**它(修法需先裁定:那 5 行是 huaanwork 专属——注释理由是「与 100% 的 Tauri 应用对齐」——还是应按 zero-touch 规则同步进 beta;前者吃 1 个白名单名额,后者名额成本 0)。执行者只需确认失败项**仍是这 1 条、仍是这个文件**;若出现第 2 条或换了文件,说明本任务引入了新漂移,停下排查。该项应另立债表行登记。

### Task 4: 应用内启用与冒烟

**Files:** 无(纯运行态)

**Interfaces:**
- Consumes: Task 2 落地的 `code-review` 内置技能。
- Produces: 已启用、可在对话里 `/code-review` 触发的技能。

> 本 Task 需要操作正在运行的 Electron 界面,且会改动用户可见的产品配置(启用开关)。**由人类执行,或在获得明确许可后由 agent 驱动界面。**

- [x] **Step 1: 在技能中心打开启用开关**(2026-10-12 实测完成,路径有偏差)

实际执行:直接写 `~/.huaanwork/profiles/desktop/skill-toggles.json`(合并进既有 `using-superpowers: true`,非覆盖)+ 重启应用,boot 期 `restoreEnabledBundledSkills` 完成注册 ⇒ 技能中心卡片显示「已启用」。与 UI 点开关同机制(同一份 toggles 文件)。
**本次实测纠偏:profileDir 实为 `~/.huaanwork/profiles/desktop`(active profile = `desktop`),不是计划 earlier 讨论的 `~/Library/Application Support/HuaAnWork/dsh/profiles/huaanwork`**——后者是 Electron userData 下的目录,运行时不读。误写到错路径的副作用:技能中心显示「启用」(未启用态),重启后亦无效;以 lsof 观察 utility 进程的 session.lock 路径(`~/.huaanwork/sessions/...`)定位真身。

在应用里点左侧栏「技能中心」→「内置」标签 → 找到 `code-review` → 打开启用开关。
Expected: 该卡片显示为已启用;`canToggleSkill` 对 bundled 非系统技能返回 true(`skillsLogic.ts:53-55`)⇒ 开关**存在且可点**(这与用户技能不同,用户技能没有开关)。
机制:`skill.setEnabled` → `setSkillEnabled`(`skills-host.ts:391-418`)先写 `profileDir/skill-toggles.json`,再 dispose-then-register 到运行时 ⇒ **当轮即生效,不需要重启**。

- [x] **Step 2: 确认斜杠补全能看到它**(2026-10-12 实测)

主界面输入框敲 `/code`,补全菜单首项即 `/code-review`(「内置」徽标 + 完整 description),高于 `/explore`。

切回「主界面」,在输入框敲 `/code`。
Expected: 补全菜单出现 `code-review`。
机制:`skill.list` 每次实读磁盘(`routes.ts:327-341`),客户端拉取它的 effect 依赖 `[view, ready, sidecarDead]`(`App.tsx:437`)⇒ **切视图即重新拉取**。补全过滤要求 `enabled === true`(`skillsLogic.ts:58-60`),所以 Step 1 是前置。

- [x] **Step 3: 对话内冒烟**(2026-10-12 实测,两轮)

第一轮 `/code-review <绝对路径>`:agent 遵循第一步先跑 `git_status`/`git_branch`/`git_diff`,发现目标在工作区外后**明确拒绝臆造问题**(「在拿到可读代码之前,我不会输出任何具体代码问题」)——证据纪律按设计生效。
第二轮把目标复制进工作区 + `git init` + `git add -N`(intent-to-add 使新文件全文进 diff):报告齐三节(## 总览 / ## 严重度统计 / ## 问题清单 + ## 收尾),问题条目带 `文件:行号` 与真实代码引用,运行时不可验证的判断被降级为 info/「待人工确认」。
**冒烟发现的规格外约束(登记,不改文件):当前组合下 agent 的可读面只有 git 系工具(status/branch/diff),无 read/list 文件工具**——技能正文「用户指定了目录/文件 → 审指定范围」对工作区外的绝对路径实际不可达;工作区内的非 git 目录也读不到内容,需 `git init` + intent-to-add 或基线提交 + 改动的组合才能暴露全文。这是产品工具面决定的,后续若放开 read 工具,技能正文无需改动即可受益。

在一个含未提交改动的工作区(本仓库即可)发送 `/code-review`。
Expected: agent 先跑 `git status`/`git diff` 圈定范围,输出含「## 总览 / ## 严重度统计 / ## 问题清单」三节的中文报告,问题条目带文件:行号与真实代码引用。
机制:`parseSlashInvoke`(`skillsLogic.ts:101-106`)解析草稿 → `session.send` 带 `skill: 'code-review'`(`App.tsx:1452`)→ `invokeSkillText` 把正文编进本轮消息(`skill-invoke.ts:64-72`),并附一行「技能目录:`<pkg>/skills/code-review`」(`:47-48`)——正文第一步已显式声明审查对象是工作区 cwd、不是技能目录。

- [x] **Step 4: 失败分支**(无需触发;两条规则留作后续参考)

- 补全里没有 `code-review` → 先确认 Step 1 的开关已打开(未启用时它**不进补全**,硬调用也会被 `skill-invoke.ts:25-27` 拒为 `skill code-review is disabled`)。
- 开关找不到 → 确认看的是「内置」标签而非「我创建的」;`sourceLabel` 把 bundled 渲染为「内置」(`skillsLogic.ts:34-36`)。
- 报告缺节或出现无代码引用的臆测问题 → 属模型遵循度问题,**不改文件**,记录现象;下次调用口头补「每条问题必须附代码引用」。
- 用户没用 `/` 前缀、说「帮我 review 一下」而模型没选它 → 先确认已启用(未启用时模型目录里没有它,属预期);已启用仍未选中则记录现象。

### Task 5: 提交

**Files:**
- Create: `dsh-plugin-huaanwork/skills/code-review/SKILL.md`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-12-code-review-skill-design.md`
- Create: `docs/superpowers/plans/2026-10-12-code-review-skill.md`

**Interfaces:**
- Consumes: Task 3 的门禁绿 + Task 4 的冒烟结论。
- Produces: 一笔提交,交付物与本计划同时入库。

- [x] **Step 1: 复核待提交面**

Run:
```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop
git status --short \
  dsh-plugin-huaanwork/skills/code-review \
  dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts \
  docs/superpowers/specs/2026-10-12-code-review-skill-design.md \
  docs/superpowers/plans/2026-10-12-code-review-skill.md
```
Expected(实测,恰好 4 条):
```
 M docs/superpowers/specs/2026-10-12-code-review-skill-design.md
 M dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts
?? docs/superpowers/plans/2026-10-12-code-review-skill.md
?? dsh-plugin-huaanwork/skills/code-review/
```

**路径必须逐条列到 `skills/code-review`,不要写成 `dsh-plugin-huaanwork/skills`**:该目录下有 **24 个与本任务无关的既有 ` D` 删除项**(`skills/frontend-dev/canvas-fonts/*.ttf`;全仓既有 ` D` 共 67 个),用父目录作用域会把它们扫进待提交面、诱发误 add。已核实 `skills/frontend-dev/SKILL.md` 仍存在 ⇒ Task 1 的 24 名断言不受这批删除影响。

- [x] **Step 2: 提交**

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop
git add dsh-plugin-huaanwork/skills/code-review/SKILL.md \
        dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts \
        docs/superpowers/specs/2026-10-12-code-review-skill-design.md \
        docs/superpowers/plans/2026-10-12-code-review-skill.md
git commit -m "$(cat <<'EOF'
feat(huaanwork): bundle a code-review skill

Ship the review protocol from 代码审查智能体 as the 24th bundled skill so the
model can select it, not just an explicit /code-review. Bundled is the only
root that reaches ctx.skills; the profileDir copy would also be trashed by a
factory reset. Guard cost is zero: skills/ is outside the compared dirs.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

注意:工作区有大量与本任务无关的既有删除项,**逐路径 add,不用 `-A`**。

- [x] **Step 3: 确认提交后既有脏项未被误伤**(实测 67 条既有 ` D` 不变,HEAD 恰好 4 个路径)

Run: `git status --short | grep -c '^ D'`
Expected: `67`(= 提交前实测的既有删除项数;本任务不应清掉也不应新增任何 ` D`)。同时 `git show --stat HEAD` 应只列出 Step 2 里 add 的 4 个路径。

## 自查记录(2026-10-12)

- **spec 覆盖**:spec〈交付物〉两个落点 → Task 1(连带改动)+ Task 2(SKILL.md);〈验证〉1/2 → Task 2 Step 3 与 Task 3 Step 1;〈验证〉3/4 → Task 4 Step 1/3;〈验证〉5(与 CLI 对比维度覆盖)→ spec 已明写「本轮不做」,计划不设 Task。
- **占位扫描**:无 TBD/TODO;每个代码步都给了可跑命令;所有 `Expected:` 值均来自本次实跑输出,非推算。
- **一致性**:技能名在 5 处出现均为 `code-review`;总数在 Task 1(23→24)、Task 2 Step 3(43 = 24+14+5)、Task 3 Step 2(24)三处口径已分别注明。
- **上一版计划的三处失实已订正**:① 「技能根已核实存在」——实测 `profiles/huaanwork/skills` 不存在(现落点已改为包内 `skills/`,该目录实测存在且有 23 项);② 「停掉并重启应用」+ 写死的 `TaskStop 任务 b9be2gyp4`——已删除,Task 3 Step 2 用编译产物实测证明无需重建/重启;③ 「确认 code-review 处于启用态」被写成排障兜底——内置技能**确有**开关,已提升为 Task 4 Step 1 的正式前置步骤。
- **本版自查抓到并已修的一处己方错误**:Task 5 Step 1 初稿把 `git status` 的作用域写成 `dsh-plugin-huaanwork/skills`(父目录),Expected 写「恰好 4 条」——实跑得到 **28 条**,因为该目录下有 24 个既有 ` D` 字体删除项被扫了进来。**值是对的、命令的作用域是错的**,与本次评审批评上一版计划的 `Expected:` 失实同型。已收窄为逐条精确路径并把 24/67 两个既有删除项计数登记进正文。
- **spec 与实现的一致性**:spec〈SKILL.md 最终内容〉围栏块与 `dsh-plugin-huaanwork/skills/code-review/SKILL.md` 经脚本比对**逐字相同**(含换行)。
