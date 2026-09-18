import type { CSSProperties } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A sliding selection indicator — the pill under a segmented control, the
 * highlight beside the active settings section.
 *
 * Instead of each option painting its own "selected" background (which snaps),
 * ONE element sits behind the options and moves to whichever carries
 * `data-key={active}`. Movement is a transform, so it composites; the first
 * measurement is applied without a transition (`ready`), so a mount never
 * shows the indicator sliding in from the origin.
 */
export function useIndicator(active: string, axis: 'x' | 'y' = 'x'): { container: React.RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const container = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 })
  const ready = useRef(false)

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const measure = (): void => {
      const el = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)
      if (!el) {
        setStyle({ opacity: 0 })
        return
      }
      const transition = ready.current ? 'transform var(--dur) var(--ease-out), width var(--dur) var(--ease-out), height var(--dur) var(--ease-out), opacity var(--dur-fast) var(--ease-out)' : 'none'
      setStyle(
        axis === 'x'
          ? { opacity: 1, width: el.offsetWidth, transform: `translateX(${el.offsetLeft}px)`, transition }
          : { opacity: 1, height: el.offsetHeight, transform: `translateY(${el.offsetTop}px)`, transition }
      )
      // Flip after the first paint so the NEXT move animates.
      requestAnimationFrame(() => {
        ready.current = true
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
  }, [active, axis])

  return { container, style }
}
