import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // dshmarket ships a nested undici. The compat spec mocks the package name
    // `undici`; without dedupe that mock hits this workspace's copy and the
    // nested copy still calls the live registry.
    dedupe: ['undici'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globalSetup: process.platform === 'win32' ? ['../scripts/prepare-test-electron.mjs'] : [],
    // Keep patched packages in Vitest's module graph so mocks reach their
    // fs/promises and undici imports instead of using the live filesystem/network.
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-host-directory-picker-browse', '@deepseek-ai/dsh-native-command', 'dshmarket'],
      },
    },
    // Profile integration tests create a full package-junction closure; higher
    // Windows file concurrency makes their latency depend on NTFS/Defender load.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
  },
})
