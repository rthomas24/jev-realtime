import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@renderer/lib/format'
import { mergeAssets, POPULAR_ASSETS, searchAssets, shortSymbol, TOP_CRYPTO, TOP_STOCKS, type AssetInfo, type AssetKind } from '@shared/tickers'

/**
 * Picking what to watch should be one tap for the names most people want
 * and one keystroke-and-Enter for everything else. Quick-pick chips first
 * (the popular stocks and coins), then a search box that completes by symbol
 * or company name — from the built-in catalogue at once, and from the full
 * live asset list once the market-data key is stored.
 */
const live: { assets: AssetInfo[] | null; promise: Promise<AssetInfo[]> | null } = { assets: null, promise: null }

function useAssets(): AssetInfo[] {
  const [list, setList] = useState<AssetInfo[]>(() => (live.assets ? mergeAssets(POPULAR_ASSETS, live.assets) : POPULAR_ASSETS))
  useEffect(() => {
    if (live.assets) return
    const api = window.tb.realtime as { assets?: () => Promise<AssetInfo[]> }
    if (typeof api.assets !== 'function') return
    live.promise ??= api.assets().catch(() => [] as AssetInfo[])
    let on = true
    void live.promise.then((a) => {
      live.assets = a
      if (on && a.length) setList(mergeAssets(POPULAR_ASSETS, a))
    })
    return () => {
      on = false
    }
  }, [])
  return list
}

export interface Picked {
  symbol: string
  kind: AssetKind
  name: string
}

export function TickerPicker({ value, onPick }: { value: Picked | null; onPick: (p: Picked) => void }): JSX.Element {
  const assets = useAssets()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const matches = useMemo(() => searchAssets(query, assets, 8), [query, assets])
  useEffect(() => setCursor(0), [query])
  const pick = (a: AssetInfo): void => {
    onPick({ symbol: a.symbol, kind: a.kind, name: a.name })
    setQuery('')
    setOpen(false)
  }
  const pickTyped = (): void => {
    const raw = query.trim().toUpperCase()
    if (matches[cursor]) return pick(matches[cursor])
    if (!raw) return
    // Nothing in any list: take the symbol as typed. A slash or a known coin reads as crypto.
    const coin = /^[A-Z0-9]{2,10}\/[A-Z]{3,5}$/.test(raw) || TOP_CRYPTO.some((c) => shortSymbol(c) === raw)
    onPick({ symbol: coin && !raw.includes('/') ? `${raw}/USD` : raw, kind: coin ? 'crypto' : 'stocks', name: '' })
    setQuery('')
    setOpen(false)
  }
  const chip = (a: AssetInfo): JSX.Element => {
    const on = value?.symbol === a.symbol && value.kind === a.kind
    return (
      <button key={`${a.kind}:${a.symbol}`} type="button" onClick={() => pick(a)} title={a.name} className={cn('mono text-xs rounded-full px-2.5 h-7 shrink-0', on ? 'bg-text text-bg' : 'bg-surface-2 hover:bg-surface-3')}>
        {shortSymbol(a)}
      </button>
    )
  }
  return (
    <div>
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          ref={inputRef}
          className="input mono text-base pl-8 pr-3"
          value={query}
          placeholder={value ? `${shortSymbol(value)}${value.name ? ` · ${value.name}` : ''} — type to change` : 'Search a ticker or company name'}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label="Ticker"
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(matches.length - 1, c + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pickTyped()
            } else if (e.key === 'Escape') setOpen(false)
          }}
        />
        {open && query.trim() && (
          <div className="absolute left-0 right-0 top-full mt-1 z-20 card-float overflow-hidden" role="listbox">
            {matches.length ? (
              matches.map((a, i) => (
                <button
                  key={`${a.kind}:${a.symbol}`}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(a)}
                  onMouseEnter={() => setCursor(i)}
                  className={cn('w-full flex items-center gap-3 px-3 h-9 text-left', i === cursor ? 'bg-surface-2' : '')}
                >
                  <span className="mono text-sm font-semibold w-20 shrink-0">{shortSymbol(a)}</span>
                  <span className="text-sm text-muted truncate flex-1">{a.name || '—'}</span>
                  <span className={cn('pill', a.kind === 'crypto' ? 'pill-accent' : '')}>{a.kind === 'crypto' ? 'Crypto' : 'Stock'}</span>
                </button>
              ))
            ) : (
              <div className="px-3 h-9 flex items-center text-sm text-muted">
                No match — press Enter to watch <span className="mono ml-1">{query.trim().toUpperCase()}</span> as typed
              </div>
            )}
          </div>
        )}
      </div>
      {value && (
        <p className="text-xs text-muted mt-1.5">
          Watching <span className="mono font-medium text-text">{shortSymbol(value)}</span>
          {value.name ? ` · ${value.name}` : ''} · {value.kind === 'crypto' ? 'crypto, trades around the clock' : 'US stock, regular session'}
        </p>
      )}
      <div className="mt-3">
        <div className="eyebrow mb-1.5">Popular stocks</div>
        <div className="flex flex-wrap gap-1.5">{TOP_STOCKS.map(chip)}</div>
        <div className="eyebrow mb-1.5 mt-3">Popular crypto</div>
        <div className="flex flex-wrap gap-1.5">{TOP_CRYPTO.map(chip)}</div>
      </div>
    </div>
  )
}
