import { readdirSync, type Dirent } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** 原 Rust has_git 命令的 Host route 实现(spec §2.2 决策 3)。 */
export function hasGit(root: string): boolean {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
    stdio: 'pipe',
    timeout: 5000,
  })
  return result.status === 0 && result.stdout.toString().trim() === 'true'
}

export type TreeNode = {
  name: string
  path: string
  isDir: boolean
  children?: TreeNode[]
}

/** 原 Rust list_tree 命令;深度缺省 2,目录优先排序,跳过 .git/node_modules。 */
export function listTree(root: string, depth = 2): TreeNode[] {
  const walk = (dir: string, level: number): TreeNode[] => {
    let dirents: Dirent[]
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const entries = dirents
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules' && e.name !== '.DS_Store')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    return entries.map((e) => {
      const path = join(dir, e.name)
      const isDir = e.isDirectory()
      const node: TreeNode = { name: e.name, path, isDir }
      if (isDir && level < depth) {
        node.children = walk(path, level + 1)
      }
      return node
    })
  }
  try {
    return walk(root, 0)
  } catch {
    return []
  }
}
