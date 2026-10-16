import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAndOpen } from '../../src/client-huaanwork/ProjectsPanel.tsx'

const createProject = vi.fn()
const openProject = vi.fn()
const removeProject = vi.fn()

vi.mock('../../src/client-huaanwork/projects.ts', () => ({
  createProject: (...args: unknown[]) => createProject(...args),
  openProject: (...args: unknown[]) => openProject(...args),
  removeProject: (...args: unknown[]) => removeProject(...args),
  renameProject: vi.fn(),
  projectRootName: (root: string) => root,
}))

const project = { id: 'p1', name: 'repo', root: '/tmp/repo', createdAt: 1 }

beforeEach(() => {
  createProject.mockReset()
  openProject.mockReset()
  removeProject.mockReset()
  createProject.mockResolvedValue({ project })
  removeProject.mockResolvedValue({ removed: true, project })
})

describe('createAndOpen', () => {
  test('打开成功时保留项目并返回工作区根', async () => {
    openProject.mockResolvedValue({ project, workspaceRoot: project.root })
    await expect(createAndOpen(project.root, project.name)).resolves.toEqual({
      project,
      workspaceRoot: project.root,
    })
    expect(removeProject).not.toHaveBeenCalled()
  })

  test('打开失败时删掉刚登记的项目,再次创建可以重新走创建', async () => {
    openProject.mockRejectedValueOnce(new Error('已取消工作区切换,项目未打开'))
    await expect(createAndOpen(project.root, project.name)).rejects.toThrow('已取消工作区切换,项目未打开')
    expect(removeProject).toHaveBeenCalledWith(project.id)

    openProject.mockResolvedValueOnce({ project, workspaceRoot: project.root })
    await expect(createAndOpen(project.root, project.name)).resolves.toEqual({
      project,
      workspaceRoot: project.root,
    })
    expect(createProject).toHaveBeenCalledTimes(2)
  })
})
