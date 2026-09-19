import type { ReactNode } from 'react'
import { useLayoutEffect } from 'react'

export type HuaanworkFrameProps = {
  dragRegion?: { height: number, leftInset: number, rightInset: number } | undefined
  children?: ReactNode
  renderSlot?: unknown
}

export function HuaanworkFrame(props: HuaanworkFrameProps) {
  const drag = props.dragRegion ?? { height: 32, leftInset: 80, rightInset: 0 }
  useLayoutEffect(() => {
    const theme = window.localStorage.getItem('huaanwork.theme')
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme
    }
  }, [])
  return (
    <div className="huaan-shell" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        aria-hidden="true"
        style={{
          height: drag.height,
          marginLeft: drag.leftInset,
          marginRight: drag.rightInset,
          flex: 'none',
          // @ts-expect-error Electron 专有 CSS 属性
          WebkitAppRegion: 'drag',
        }}
      />
      <div className="huaan-shell-body" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {props.children ?? <div style={{ padding: 24, fontFamily: 'sans-serif' }}>HuaAnWork M2 骨架</div>}
      </div>
    </div>
  )
}

export function HuaanworkApp(props: { dragRegion?: HuaanworkFrameProps['dragRegion'], tree: ReactNode }) {
  return <HuaanworkFrame dragRegion={props.dragRegion}>{props.tree}</HuaanworkFrame>
}
