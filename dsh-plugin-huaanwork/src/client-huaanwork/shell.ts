import React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../client/contracts.ts'
import type { DesktopClientEnvironment } from '../client/environment.ts'
import { DesktopLayoutState } from '../client/layout-state.ts'
import { installDesktopLayout } from '../client/layout-service.ts'
import { HuaanworkApp } from './frame.tsx'
import App from './App.tsx'
import { HUAANWORK_STYLES } from './styles.generated.ts'

function installHuaanworkStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('huaanwork-styles')) return
  const style = document.createElement('style')
  style.id = 'huaanwork-styles'
  style.textContent = HUAANWORK_STYLES
  document.head.appendChild(style)

  if (!document.getElementById('huaanwork-fonts')) {
    const link = document.createElement('link')
    link.id = 'huaanwork-fonts'
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..800;1,9..144,300..800&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&family=Noto+Sans+SC:wght@300..800&family=Noto+Serif+SC:wght@300..900&display=swap'
    document.head.appendChild(link)
  }
}

export function applyHuaanworkShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'advanced') {
    throw new Error(`dsh-plugin-huaanwork: huaanwork shell received mode ${JSON.stringify(environment.mode)}`)
  }
  installHuaanworkStyles()
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
          inject: () => ({
            layout: desktopLayout,
            platform: environment.platform,
            tree: React.createElement(App),
            dragRegion: ctx.desktopWindow?.dragRegion,
          }),
        },
        HuaanworkApp,
      ),
    'huaanwork: root slot',
  )
}
