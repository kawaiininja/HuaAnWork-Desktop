import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopClientEnvironment } from '../client/environment.ts'
import { DesktopLayoutState } from '../client/layout-state.ts'
import { installDesktopLayout } from '../client/layout-service.ts'
import { HuaanworkFrame } from './frame.tsx'

export function applyHuaanworkShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'advanced') {
    throw new Error(`dsh-plugin-huaanwork: huaanwork shell received mode ${JSON.stringify(environment.mode)}`)
  }
  const desktopLayout = new DesktopLayoutState(
    (id) => ctx.slots.entries('main').some((entry) => entry.options.key === id),
  )
  installDesktopLayout(ctx, desktopLayout)
  ctx.effect(
    () =>
      ctx.slots.register(
        {
          name: 'root',
          children: {
            sidebar: { kind: 'single', scope: 'root' },
            main: { kind: 'keyed', scope: 'root' },
            rightbar: { kind: 'single', scope: 'root' },
            'shell.overlay': { kind: 'list', scope: 'root' },
          },
          inject: () => ({ layout: desktopLayout, platform: environment.platform }),
        },
        HuaanworkFrame,
      ),
    'huaanwork: root slot',
  )
}
