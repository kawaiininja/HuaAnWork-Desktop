/**
 * 可写根推导(规格 §3.2.3)。被测函数是同步推导:projects / tasks / headerCwd 都由
 * 调用方预先载入,函数不异步、不调 listProjects / listTasks / findSessionHeader;
 * 唯一允许的读盘是中立前缀会话对 `workspace-sessions/<sessionId>` 至多两次
 * existsSync + statSync 检查,唯一副作用是中立根作为结果返回时创建 `<profile>/workspace`。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { freshSessionIdFor, sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import {
  neutralAutomationRoot,
  neutralAutomationRootPath,
  neutralSessionRoot,
  neutralSessionRootPath,
  neutralSessionsBaseDir,
  neutralWorkspaceRoot,
} from '../../src/huaanwork-host/workspace-state.ts'
import { writableRootForSession } from '../../src/huaanwork-host/writable-root.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

test('fresh project session and lost task binding stay on that project', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-root-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-proj-'))
  dirs.push(profile, project)
  const fresh = freshSessionIdFor(project)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: fresh,
    projects: [{ id: 'p', root: project }],
    tasks: [],
  })).toBe(resolve(project))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'legacy',
    projects: [{ id: 'p', root: project }],
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(resolve(project))
})

test('unknown session falls back to the neutral workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-neutral-'))
  dirs.push(profile)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'nope',
    projects: [],
    tasks: [],
  })).toBe(neutralWorkspaceRoot(profile))
})

test('a project derivation does not create the neutral workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-side-effect-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-side-effect-project-'))
  dirs.push(profile, project)
  const neutralPath = join(profile, 'workspace')
  // 非稳定 id + cwd 落在项目内:推导要走到中立根的稳定 id 比较之后才命中项目,
  // 正是此前会顺带 mkdir 的路径。
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'legacy',
    projects: [{ id: 'p', root: project }],
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(resolve(project))
  expect(existsSync(neutralPath)).toBe(false)
})

test('the neutral derivation creates the neutral workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-neutral-create-profile-'))
  dirs.push(profile)
  const neutralPath = join(profile, 'workspace')
  expect(existsSync(neutralPath)).toBe(false)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'legacy',
    projects: [],
    tasks: [],
  })).toBe(resolve(neutralPath))
  expect(existsSync(neutralPath)).toBe(true)
})

test('a task binding wins over a session id prefix from another project', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-task-profile-'))
  const alpha = mkdtempSync(join(tmpdir(), 'huaanwork-task-alpha-'))
  const beta = mkdtempSync(join(tmpdir(), 'huaanwork-task-beta-'))
  dirs.push(profile, alpha, beta)
  // 会话 id 前缀属于 alpha,但任务把它绑到了 beta:任务绑定优先。
  const sessionId = freshSessionIdFor(alpha)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId,
    projects: [{ id: 'alpha', root: alpha }, { id: 'beta', root: beta }],
    tasks: [{ projectId: 'beta', sessionId }],
  })).toBe(resolve(beta))
})

test('the stable id beats the logged cwd', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-order-profile-'))
  const alpha = mkdtempSync(join(tmpdir(), 'huaanwork-order-alpha-'))
  const beta = mkdtempSync(join(tmpdir(), 'huaanwork-order-beta-'))
  dirs.push(profile, alpha, beta)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: sessionIdFor(alpha),
    projects: [{ id: 'alpha', root: alpha }, { id: 'beta', root: beta }],
    tasks: [],
    headerCwd: join(beta, 'notes'),
  })).toBe(resolve(alpha))
})

test('the stable id must match in full or with a dash suffix', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-fragment-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-fragment-project-'))
  dirs.push(profile, project)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const projects = [{ id: 'p', root: project }]
  expect(writableRootForSession({ profileDir: profile, sessionId: sessionIdFor(project), projects, tasks: [] }))
    .toBe(resolve(project))
  expect(writableRootForSession({ profileDir: profile, sessionId: `${sessionIdFor(project)}-deadbeef`, projects, tasks: [] }))
    .toBe(resolve(project))
  // 比完整稳定 id 更短的片段不得命中。
  expect(writableRootForSession({ profileDir: profile, sessionId: sessionIdFor(project).slice(0, -1), projects, tasks: [] }))
    .toBe(neutral)
  expect(writableRootForSession({ profileDir: profile, sessionId: sessionIdFor(project).replace('huaanwork-', ''), projects, tasks: [] }))
    .toBe(neutral)
  // 稳定 id 后必须跟 `-`,直接拼接不算同一会话。
  expect(writableRootForSession({ profileDir: profile, sessionId: `${sessionIdFor(project)}x`, projects, tasks: [] }))
    .toBe(neutral)
})

test('the neutral stable id stays neutral even when the logged cwd is inside a project', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-neutral-id-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-neutral-id-project-'))
  dirs.push(profile, project)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const neutralStable = sessionIdFor(neutralWorkspaceRoot(profile)) // 规格原文写法
  const projects = [{ id: 'p', root: project }]
  // 中立根同样承载「通道默认会话」的稳定 id(规格 §5.1.1 第 2 步):命中它时先于 cwd 规则,
  // 不因 header.cwd 落在某个项目内而改判到项目根。
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: neutralStable,
    projects,
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(neutral)
  // 稳定 id 加 `-` 随机后缀同样命中中立根。
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: `${neutralStable}-abc12345`,
    projects,
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(neutral)
  // 同一 id 只可能等于一个根的稳定 id:项目根仍按项目根返回,不被中立匹配抢走。
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: sessionIdFor(project),
    projects,
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(resolve(project))
})

test('the logged cwd counts only when it sits inside the project root', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-cwd-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-cwd-project-'))
  dirs.push(profile, project)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const projects = [{ id: 'p', root: project }]
  // 等于根。
  expect(writableRootForSession({ profileDir: profile, sessionId: 'legacy', projects, tasks: [], headerCwd: project }))
    .toBe(resolve(project))
  // 在根之内(不需要真实存在)。
  expect(writableRootForSession({ profileDir: profile, sessionId: 'legacy', projects, tasks: [], headerCwd: join(project, 'src', 'a.ts') }))
    .toBe(resolve(project))
  // 根的父目录不在根内。
  expect(writableRootForSession({ profileDir: profile, sessionId: 'legacy', projects, tasks: [], headerCwd: resolve(project, '..') }))
    .toBe(neutral)
})

test('a cwd inside two nested project roots is ambiguous and falls to neutral', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-nested-profile-'))
  const outer = mkdtempSync(join(tmpdir(), 'huaanwork-nested-outer-'))
  const inner = join(outer, 'packages', 'inner')
  dirs.push(profile, outer)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const projects = [{ id: 'outer', root: outer }, { id: 'inner', root: inner }]
  // 只落在外层根内:就是外层。
  expect(writableRootForSession({ profileDir: profile, sessionId: 'legacy', projects, tasks: [], headerCwd: join(outer, 'docs', 'a.md') }))
    .toBe(resolve(outer))
  // 同时落在两层根内:不猜,落中立根。
  expect(writableRootForSession({ profileDir: profile, sessionId: 'legacy', projects, tasks: [], headerCwd: join(inner, 'a.ts') }))
    .toBe(neutral)
})

test('two registrations of the same directory are one root, not an ambiguity', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-dupe-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-dupe-project-'))
  dirs.push(profile, project)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'legacy',
    projects: [{ id: 'one', root: project }, { id: 'two', root: project }],
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(resolve(project))
})

test('a task whose project is gone falls through to the remaining rules', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-dangling-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-dangling-project-'))
  dirs.push(profile, project)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const projects = [{ id: 'p', root: project }]
  // 会话与悬挂任务必须共用同一个 id:两个 id 不同时第一条断言靠稳定 id 前缀就能过,
  // 走不到「任务指向已消失项目 → 继续回落」这条路径。
  const danglingTaskSession = freshSessionIdFor(project)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: danglingTaskSession,
    projects,
    tasks: [{ projectId: 'deleted', sessionId: danglingTaskSession }],
  })).toBe(resolve(project))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'legacy',
    projects,
    tasks: [{ projectId: 'deleted', sessionId: 'legacy' }],
  })).toBe(neutral)
})

test('minted fresh neutral session resolves to its workspace-sessions sibling root without side effects on unknown ids', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-fresh-neutral-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const mintedId = freshSessionIdFor(neutral)
  const mintedRoot = resolve(neutralSessionRoot(profile, mintedId))

  // 1. 刚由 session.new 铸造（目录已存在，尚未落首条 headerCwd）⇒ 返回该独立子根
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: mintedId,
    projects: [],
    tasks: [],
  })).toBe(mintedRoot)

  // 2. 已落盘在独立根（或其子目录）上的会话 ⇒ 返回该独立子根（即使不靠 existsSync 分支）
  const persistedId = freshSessionIdFor(neutral)
  const persistedRoot = resolve(neutralSessionRootPath(profile, persistedId))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: persistedId,
    projects: [],
    tasks: [],
    headerCwd: join(persistedRoot, 'subdir'),
  })).toBe(persistedRoot)
  expect(existsSync(persistedRoot)).toBe(false)

  // 3. 未经 session.new 铸造的未知/伪造中立前缀 id ⇒ 回落 neutralRoot 且绝不创建 workspace-sessions 目录
  const unmintedId = `${sessionIdFor(neutral)}-deadbeef`
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: unmintedId,
    projects: [],
    tasks: [],
  })).toBe(neutral)
  expect(existsSync(neutralSessionRootPath(profile, unmintedId))).toBe(false)
})

test('legacy neutral sessions with headerCwd equal to or inside <profileDir>/workspace stay on <profileDir>/workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-legacy-neutral-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const legacyId = freshSessionIdFor(neutral)

  expect(writableRootForSession({
    profileDir: profile,
    sessionId: legacyId,
    projects: [],
    tasks: [],
    headerCwd: neutral,
  })).toBe(neutral)

  expect(writableRootForSession({
    profileDir: profile,
    sessionId: legacyId,
    projects: [],
    tasks: [],
    headerCwd: join(neutral, 'docs', 'notes'),
  })).toBe(neutral)
  expect(existsSync(neutralSessionsBaseDir(profile))).toBe(false)
})

test('legacy unbound automation session with headerCwd under workspace-automations resolves to its automation root', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-legacy-auto-root-'))
  dirs.push(profile)
  const autoRoot = resolve(neutralAutomationRoot(profile, 'auto-legacy-1'))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'huaanwork-auto-auto-legacy-1-run1',
    projects: [],
    tasks: [],
    headerCwd: autoRoot,
  })).toBe(autoRoot)
})

test('an unminted neutral-prefixed session with headerCwd under workspace-automations stays on <profileDir>/workspace (D4)', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-neutral-auto-cwd-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  // 合法中立前缀但从未经 session.new 铸造,headerCwd 落在自动化目录:第 3 级就停在中立根,
  // 不再走第 5 级的自动化目录识别。
  const unmintedId = `${sessionIdFor(neutral)}-deadbeef`
  const autoRoot = neutralAutomationRootPath(profile, 'auto-legacy-1')
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: unmintedId,
    projects: [],
    tasks: [],
    headerCwd: join(autoRoot, 'notes'),
  })).toBe(neutral)
  expect(existsSync(autoRoot)).toBe(false)
  expect(existsSync(neutralSessionRootPath(profile, unmintedId))).toBe(false)
})

test('invalid path segment in sessionId with neutral prefix throws instead of falling back to neutral root', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-bad-seg-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const neutralStable = sessionIdFor(neutral)
  expect(() =>
    writableRootForSession({
      profileDir: profile,
      sessionId: `${neutralStable}-../escape`,
      projects: [],
      tasks: [],
    }),
  ).toThrow(/非法 sessionId/)
})

test('a project registered on the neutral workspace does not capture a minted fresh session', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-workspace-project-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const mintedId = freshSessionIdFor(neutral)
  const mintedRoot = resolve(neutralSessionRoot(profile, mintedId))
  const projects = [{ id: 'workspace-as-project', root: neutral }]
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: mintedId,
    projects,
    tasks: [],
  })).toBe(mintedRoot)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: sessionIdFor(neutral),
    projects,
    tasks: [],
  })).toBe(neutral)
})
