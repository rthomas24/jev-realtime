import type { JSX } from 'react'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/lib/format'
import { useIndicator } from '@renderer/lib/indicator'

/**
 * True while the sheet is on its way out. Provided by App's sheet host, which
 * keeps the last sheet mounted for the length of the exit transition after the
 * store has already forgotten it — so Cancel, Save, Escape and the backdrop all
 * leave the same way without every sheet knowing about animation.
 */
export const SheetClosing = createContext(false)

/** Right-side slide-over panel used for every non-thread surface. */
export function Sheet({ title, onClose, children, width = 460, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }): JSX.Element {
  const closing = useContext(SheetClosing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    // `no-drag` is load-bearing and its absence was invisible.
    //
    // Electron hands `-webkit-app-region: drag` regions to the OS as plain
    // RECTANGLES, and that hit-testing is not z-index aware: rendering an
    // overlay on top does not reclaim those pixels. The thread header, the
    // account header and the sidebar are all `drag` bands across the top of the
    // window, and this sheet's own header lands inside them — so every click on
    // the close button was consumed by the OS as "drag the window". Set on the
    // OUTER container: the property is inherited, so this also reclaims the
    // backdrop, whose top 56px were swallowed the same way.
    <div className="no-drag fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal data-closing={closing || undefined} inert={closing || undefined}>
      <div className="sheet-backdrop absolute inset-0" onClick={onClose} />
      <div className="sheet-panel relative h-full flex flex-col bg-bg" style={{ width: `min(${width}px, 92vw)` }}>
        {/* The sheet header is the app header's height, so a sheet opening over
            the window reads as the same band continuing, not a second chrome. */}
        <header className="flex items-center pl-5 pr-3 h-[var(--h-header)] shrink-0 hair-b">
          <h2 className="text-md font-semibold tracking-[-0.01em] flex-1 truncate">{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
          <div aria-hidden className="shrink-0" style={{ width: 'var(--wco-pad, 0px)' }} />
        </header>
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-6">{children}</div>
        {footer && <footer className="px-5 py-2.5 hair-t shrink-0 flex items-center justify-end gap-2 bg-bg">{footer}</footer>}
      </div>
    </div>
  )
}

/** Label, control, then the sentence that explains it — in that reading order. */
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('mb-5', className)}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="hint mt-1.5">{hint}</p>}
    </div>
  )
}

/**
 * Segmented control with ONE sliding thumb behind the options (see
 * `useIndicator`). The thumb is what paints the selection, so the options
 * themselves only change colour — a second `data-on` background would snap into
 * place while the thumb was still travelling.
 */
export function Segmented<T extends string>({ value, onChange, options, block, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[]; block?: boolean; size?: 'sm' | 'md' }): JSX.Element {
  const { container, style } = useIndicator(value)
  return (
    <div ref={container} role="tablist" className={cn('seg relative', block && 'flex w-full')}>
      <span aria-hidden className="absolute top-0.5 bottom-0.5 left-0 rounded-xs bg-surface" style={{ boxShadow: 'var(--shadow-1), 0 0 0 1px var(--color-line-faint)', ...style }} />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          data-key={o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          // The hover colour is spelled out rather than left to `.seg-item:hover`:
          // a utility class wins over a component-layer rule whatever its
          // specificity, so `text-muted` alone would sit on top of the hover.
          className={cn('seg-item relative z-10', size === 'sm' && 'h-6 px-2.5 text-xs', value === o.value ? 'text-text' : 'text-muted hover:text-text')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
