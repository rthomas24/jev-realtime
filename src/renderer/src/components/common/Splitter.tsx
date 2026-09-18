import type { JSX } from 'react'
import { useCallback, useRef, useState } from 'react'
import { cn } from '@renderer/lib/format'

/**
 * A panel width the operator can drag, remembered per key in localStorage
 * and clamped to a sane range. `reset` returns it to the default.
 */
export function usePanelWidth(key: string, initial: number, min: number, max: number): { width: number; set: (w: number) => void; reset: () => void } {
  const clamp = useCallback((n: number): number => Math.round(Math.min(max, Math.max(min, n))), [min, max])
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? clamp(v) : initial
  })
  const set = useCallback(
    (w: number): void => {
      const c = clamp(w)
      setWidth(c)
      localStorage.setItem(key, String(c))
    },
    [clamp, key]
  )
  const reset = useCallback((): void => {
    setWidth(initial)
    localStorage.removeItem(key)
  }, [initial, key])
  return { width, set, reset }
}

/**
 * The vertical drag handle between two panels. It sits on the seam (9 px
 * wide, overlapping the gap on both sides so the hit area is generous) and
 * lights up on hover and while dragging. `grows` says which side's panel
 * the width belongs to: dragging right grows a `left` panel and shrinks a
 * `right` one. Double-click resets. Pointer events with capture, so a fast
 * drag that leaves the handle keeps following the pointer.
 */
export function Splitter({ width, onResize, onReset, grows, label }: { width: number; onResize: (w: number) => void; onReset?: () => void; grows: 'left' | 'right'; label: string }): JSX.Element {
  const [active, setActive] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      title="Drag to resize · double-click to reset"
      className={cn('splitter no-drag', active && 'splitter-active')}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        setActive(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        const delta = e.clientX - s.x
        onResize(grows === 'left' ? s.w + delta : s.w - delta)
      }}
      onPointerUp={(e) => {
        start.current = null
        setActive(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
      }}
      onPointerCancel={() => {
        start.current = null
        setActive(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }}
      onDoubleClick={() => onReset?.()}
    />
  )
}
