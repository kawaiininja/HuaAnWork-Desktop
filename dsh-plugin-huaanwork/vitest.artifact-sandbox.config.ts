import { defineConfig } from 'vitest/config'

// 真实图形探针单独进入本配置：默认 workspace `test`、根 `test`/`check` 与 Ubuntu
// check job 都不会启动它；仅 desktop-windows/desktop-macos 或有图形会话的机器运行。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/electron/artifact-sandbox-probe.electron.ts'],
    globalSetup: process.platform === 'win32' ? ['../scripts/prepare-test-electron.mjs'] : [],
  },
})
