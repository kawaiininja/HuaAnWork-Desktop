import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  RUNS_LIMIT,
  bindTaskSession,
  createProject,
  createTask,
  findAutomation,
  listAutomations,
  listProjects,
  listTasks,
  readAutomationTemplates,
  recentRuns,
  removeAutomationsOfProject,
  removeProject,
  removeTask,
  removeTasksOfProject,
  renameProject,
  renameTask,
  touchProject,
} from '../../src/huaanwork-host/stores.ts'
import type { AutomationInfo } from '../../src/client-huaanwork/rpc-types.ts'

// 读路径用例移植自旧 sidecar projects.test.ts / tasks.test.ts / automations.test.ts:
// 排序口径、坏行过滤、级联删、legacy 五字段回填、损坏注册表容错。
// 存储根 = 临时 profileDir(与旧 $DSH_HOME 布局同名文件)。

let homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-stores-'))
  homes.push(home)
  return home
}

afterEach(() => {
  vi.useRealTimers()
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

function writeJson(home: string, name: string, value: unknown): void {
  writeFileSync(join(home, name), JSON.stringify(value), 'utf8')
}

function makeAutomation(id: string, projectId: string | null, createdAt: number): AutomationInfo {
  return {
    id,
    projectId,
    name: `任务-${id}`,
    kind: 'agent',
    schedule: { kind: 'manual' },
    widget: false,
    enabled: true,
    createdAt,
  }
}

describe('projects 读路径(旧 projects.test.ts 用例)', () => {
  test('listProjects 按 lastOpenedAt ?? createdAt 倒序;create/rename/remove/touch 全链路', async () => {
    const home = makeHome()
    const rootA = join(home, 'repo-a')
    const rootB = join(home, 'repo-b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })

    // Precondition constructed, not raced (controller ruling R-6.1-1, lifted in
    // the Phase 6 final-review wave): createProject stamps `createdAt: Date.now()`
    // and listProjects' sort has no tiebreak, so two creates in the same
    // millisecond leave the [b, a] order to file order. Only Date is faked, so
    // fs promises and the rest of vitest keep the real clock.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const a = await createProject(home, { root: rootA })
    vi.setSystemTime(2_000)
    const b = await createProject(home, { name: '显式名', root: rootB })
    expect(a.name).toBe('repo-a')
    expect(b.name).toBe('显式名')
    // The precondition itself, pinned: b provably post-dates a.
    expect([a.createdAt, b.createdAt]).toEqual([1_000, 2_000])

    // 初始按 createdAt 倒序(b 后建在前)。
    expect((await listProjects(home)).map((p) => p.id)).toEqual([b.id, a.id])

    // touch 后 a 排到最前。
    vi.setSystemTime(3_000)
    await touchProject(home, a.id)
    expect((await listProjects(home)).map((p) => p.id)).toEqual([a.id, b.id])

    // rename 后读到新名;touch 不存在项目静默通过。
    const renamed = await renameProject(home, b.id, '  新名字  ')
    expect(renamed.name).toBe('新名字')
    await touchProject(home, 'missing')

    // remove 返回被删项;重复 remove 报 not found。
    const removed = await removeProject(home, b.id)
    expect(removed.id).toBe(b.id)
    expect((await listProjects(home))).toHaveLength(1)
    await expect(removeProject(home, b.id)).rejects.toThrow(/was not found/)
  })

  test('project.create 拒绝不存在目录与重复 root(旧中文文案)', async () => {
    const home = makeHome()
    const root = join(home, 'repo')
    await expect(createProject(home, { root })).rejects.toThrow(/requires an existing directory/)
    mkdirSync(root, { recursive: true })
    await createProject(home, { root })
    await expect(createProject(home, { root })).rejects.toThrow(/该目录已是项目：repo/)
    await expect(createProject(home, { root: '   ' })).rejects.toThrow(/requires params.root/)
  })

  test('projects.json 坏行过滤:只保留合法行(旧 projects.test.ts:126)', async () => {
    const home = makeHome()
    writeJson(home, 'projects.json', {
      projects: [{ id: 'keep', name: 'ok', root: '/tmp/keep', createdAt: 1 }, { id: 42 }, 'junk'],
    })
    const listed = await listProjects(home)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe('keep')
  })

  test('projects.json 缺失时返回空表', async () => {
    const home = makeHome()
    expect(await listProjects(home)).toEqual([])
  })
})

describe('tasks 读路径(旧 tasks.test.ts 用例)', () => {
  test('listTasks 按 createdAt 升序并可按 projectId 过滤;create 校验 projectId/name', async () => {
    const home = makeHome()
    const first = await createTask(home, { projectId: 'p1', name: '甲' }, 100)
    await createTask(home, { projectId: 'p2', name: '别项目' }, 200)
    const third = await createTask(home, { projectId: 'p1', name: '乙' }, 300)

    const scoped = await listTasks(home, 'p1')
    expect(scoped.map((t) => t.id)).toEqual([first.id, third.id])
    expect(await listTasks(home, 'missing')).toEqual([])

    await expect(createTask(home, { projectId: ' ', name: 'x' })).rejects.toThrow(/projectId/)
    await expect(createTask(home, { projectId: 'p1', name: '  ' })).rejects.toThrow(/name/)
  })

  test('并发 20 个 createTask 全保留(注册表互斥链)', async () => {
    const home = makeHome()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => createTask(home, { projectId: 'p1', name: `子任务 ${i}` }, 1000 + i)),
    )
    expect(await listTasks(home)).toHaveLength(20)
  })

  test('bindTaskSession 一对一:幂等、已绑拒、会话占用拒;rename/remove 语义', async () => {
    const home = makeHome()
    const task = await createTask(home, { projectId: 'p1', name: 't' }, 1)
    const other = await createTask(home, { projectId: 'p1', name: 'o' }, 2)

    // 重复绑同一会话幂等。
    const bound = await bindTaskSession(home, { taskId: task.id, sessionId: 's1' })
    expect(bound.sessionId).toBe('s1')
    expect((await bindTaskSession(home, { taskId: task.id, sessionId: 's1' })).sessionId).toBe('s1')

    // 已绑任务换绑拒绝;会话被占拒绝。
    await expect(bindTaskSession(home, { taskId: task.id, sessionId: 's2' }))
      .rejects.toThrow(`task ${task.id} is already bound to session s1`)
    await expect(bindTaskSession(home, { taskId: other.id, sessionId: 's1' }))
      .rejects.toThrow(`session s1 is already bound to task ${task.id}`)
    await expect(bindTaskSession(home, { taskId: 'missing', sessionId: 's9' })).rejects.toThrow(/was not found/)
    await expect(bindTaskSession(home, { taskId: task.id, sessionId: ' ' })).rejects.toThrow(/sessionId/)

    // rename。
    const renamed = await renameTask(home, { taskId: task.id, name: ' 新名 ' })
    expect(renamed.name).toBe('新名')
    await expect(renameTask(home, { taskId: task.id, name: ' ' })).rejects.toThrow(/name/)

    // remove 返回被删任务;重复 remove 报 not found。
    const removed = await removeTask(home, other.id)
    expect(removed.id).toBe(other.id)
    await expect(removeTask(home, other.id)).rejects.toThrow(/was not found/)
  })

  test('removeTasksOfProject 级联返回被删任务绑定过的 sessionId', async () => {
    const home = makeHome()
    const a = await createTask(home, { projectId: 'p1', name: 'a' }, 1)
    const b = await createTask(home, { projectId: 'p1', name: 'b' }, 2)
    await createTask(home, { projectId: 'p2', name: 'keep' }, 3)
    await bindTaskSession(home, { taskId: a.id, sessionId: 'sa' })
    await bindTaskSession(home, { taskId: b.id, sessionId: 'sb' })

    const cascaded = await removeTasksOfProject(home, 'p1')
    expect(cascaded.sort()).toEqual(['sa', 'sb'])
    expect((await listTasks(home)).map((t) => t.projectId)).toEqual(['p2'])

    // 无子任务的项目级联为空数组。
    expect(await removeTasksOfProject(home, 'p1')).toEqual([])
  })
})

describe('automations 读路径(旧 automations.test.ts 用例)', () => {
  test('listAutomations 按 createdAt 升序、可按 projectId 过滤;findAutomation not found', async () => {
    const home = makeHome()
    writeJson(home, 'automations.json', {
      automations: [
        makeAutomation('a2', 'p1', 200),
        makeAutomation('a1', 'p1', 100),
        makeAutomation('neutral', null, 50),
      ],
    })
    expect((await listAutomations(home)).map((a) => a.id)).toEqual(['neutral', 'a1', 'a2'])
    expect((await listAutomations(home, 'p1')).map((a) => a.id)).toEqual(['a1', 'a2'])
    expect((await findAutomation(home, 'a1')).id).toBe('a1')
    await expect(findAutomation(home, 'missing')).rejects.toThrow(/was not found/)
  })

  test('automations.json 坏行过滤:非法条目不入列(projectId 可空为合法)', async () => {
    const home = makeHome()
    writeJson(home, 'automations.json', {
      automations: [
        makeAutomation('keep', 'p1', 1),
        { id: 'no-schedule', projectId: 'p1', name: 'x', kind: 'agent', createdAt: 1 },
        'junk',
      ],
    })
    const listed = await listAutomations(home)
    expect(listed.map((a) => a.id)).toEqual(['keep'])
  })

  test('注册表损坏:改名留证(.corrupt-*)并返回空表', async () => {
    const home = makeHome()
    writeFileSync(join(home, 'automations.json'), '{broken json', 'utf8')
    expect(await listAutomations(home)).toEqual([])
    const backups = readdirSync(home).filter((name) => name.startsWith('automations.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(existsSync(join(home, backups[0]!))).toBe(true)
  })

  test('recentRuns 坏行跳过 + limit 取尾 + 缺失文件返回空', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'automations'), { recursive: true })
    const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({
      runId: `r${i}`,
      startedAt: 1000 + i,
      endedAt: 1001 + i,
      ok: i % 2 === 0,
      output: `out-${i}`,
    }))
    writeFileSync(join(home, 'automations', 'a1.runs.jsonl'), `${lines.join('\n')}\n{bbroken\n`, 'utf8')

    const runs = await recentRuns(home, 'a1')
    expect(runs).toHaveLength(50)
    expect(runs[0]!.runId).toBe('r10')
    expect(runs.at(-1)?.runId).toBe('r59')

    expect((await recentRuns(home, 'a1', 3))).toHaveLength(3)
    expect(await recentRuns(home, 'missing')).toEqual([])
  })

  test('recentRuns legacy 五字段回填:status 按 ok 推导、trigger 补 schedule、非法字面量收敛', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'automations'), { recursive: true })
    const legacy = [
      { runId: 'r1', startedAt: 1000, endedAt: 1100, ok: true, output: 'fine' },
      { runId: 'r2', startedAt: 1200, endedAt: 1300, ok: false, output: 'boom' },
      // 已带新字段的记录保持原值,不得被默认值覆盖。
      { runId: 'r3', startedAt: 1400, endedAt: 1500, ok: true, output: 'kept', status: 'cancelled', trigger: 'manual' },
      // 非法字面量收敛为合法默认值,不得穿透类型契约。
      { runId: 'r4', startedAt: 1600, endedAt: 1700, ok: false, output: 'bad-literal', status: 'banana', trigger: 42 },
    ]
    writeFileSync(join(home, 'automations', 'legacy.runs.jsonl'), `${legacy.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')

    const runs = await recentRuns(home, 'legacy')
    expect(runs).toHaveLength(4)
    expect(runs[0]!.status).toBe('ok')
    expect(runs[0]!.trigger).toBe('schedule')
    expect(runs[1]!.status).toBe('error')
    expect(runs[1]!.trigger).toBe('schedule')
    expect(runs[2]!.status).toBe('cancelled')
    expect(runs[2]!.trigger).toBe('manual')
    expect(runs[3]!.status).toBe('error')
    expect(runs[3]!.trigger).toBe('schedule')
  })

  test('removeAutomationsOfProject 级联:注册表条目 + 运行历史一并清理', async () => {
    const home = makeHome()
    writeJson(home, 'automations.json', {
      automations: [makeAutomation('a1', 'p1', 1), makeAutomation('a2', 'p2', 2)],
    })
    mkdirSync(join(home, 'automations'), { recursive: true })
    writeFileSync(join(home, 'automations', 'a1.runs.jsonl'), `${JSON.stringify({
      runId: 'r1', startedAt: 1, endedAt: 2, ok: true, output: 'x',
    })}\n`, 'utf8')
    writeFileSync(join(home, 'automations', 'a2.runs.jsonl'), `${JSON.stringify({
      runId: 'r2', startedAt: 1, endedAt: 2, ok: true, output: 'x',
    })}\n`, 'utf8')

    await removeAutomationsOfProject(home, 'p1')

    expect((await listAutomations(home)).map((a) => a.id)).toEqual(['a2'])
    expect(existsSync(join(home, 'automations', 'a1.runs.jsonl'))).toBe(false)
    expect(existsSync(join(home, 'automations', 'a2.runs.jsonl'))).toBe(true)

    // 无命中项目时为空操作。
    await removeAutomationsOfProject(home, 'p1')
    expect((await listAutomations(home))).toHaveLength(1)
  })

  test('RUNS_LIMIT = 50(运行历史上限与旧契约一致)', () => {
    expect(RUNS_LIMIT).toBe(50)
  })
})

describe('readAutomationTemplates(旧 templates.ts:23)', () => {
  test('读取随包分发的 templates/automations.json(数组,含既有模板名)', async () => {
    const templates = await readAutomationTemplates()
    expect(Array.isArray(templates)).toBe(true)
    expect(templates.length).toBeGreaterThan(0)
    const names = templates.map((t) => t.name)
    expect(names).toContain('每日投研早报')
    for (const template of templates) {
      expect(template.kind === 'agent' || template.kind === 'script').toBe(true)
      expect(typeof template.schedule).toBe('object')
    }
  })
})
