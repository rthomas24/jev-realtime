import { useCallback, useMemo, useState } from 'react'

/**
 * The operator's own order for the watched names, and the drag that changes
 * it. One order serves both views — the list on the left and the tiles in
 * the middle — so dragging in either one moves the name in both.
 *
 * The saved order is a list of row keys, not positions: a name that is added
 * later, or one the list has never seen, simply falls to the end in its
 * natural order rather than corrupting everything after it.
 */
export type RowKey = string
export const rowKey = (agentId: string, symbol: string): RowKey => `${agentId}:${symbol}`

const STORE_KEY = 'rt:row-order'
const MAX_KEYS = 200

function load(): RowKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

export interface DragProps {
  draggable: true
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

export interface Ordering {
  /** Rows in the operator's order; anything unseen keeps its natural place at the end. */
  sort<T>(rows: readonly T[], keyOf: (row: T) => RowKey): T[]
  /** The row being dragged right now, if any. */
  dragKey: RowKey | null
  /** The row it is hovering, and which side of it the dragged row would land. */
  over: { key: RowKey; side: 'before' | 'after' } | null
  /** Everything a row needs to be a drag source and a drop target. `keys` is the list it belongs to, in view order. */
  dragProps(key: RowKey, keys: readonly RowKey[]): DragProps
}

export function useRowOrder(): Ordering {
  const [order, setOrder] = useState<RowKey[]>(load)
  const [dragKey, setDragKey] = useState<RowKey | null>(null)
  const [over, setOver] = useState<{ key: RowKey; side: 'before' | 'after' } | null>(null)

  const sort = useCallback(
    <T,>(rows: readonly T[], keyOf: (row: T) => RowKey): T[] => {
      if (!order.length) return [...rows]
      const at = new Map(order.map((k, i) => [k, i]))
      return rows
        .map((row, i) => ({ row, i, rank: at.get(keyOf(row)) ?? Number.POSITIVE_INFINITY }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.row)
    },
    [order]
  )

  const move = useCallback(
    (dragged: RowKey, target: RowKey, keys: readonly RowKey[]): void => {
      const from = keys.indexOf(dragged)
      const to = keys.indexOf(target)
      if (from < 0 || to < 0 || from === to) return
      const next = keys.filter((k) => k !== dragged)
      next.splice(next.indexOf(target) + (from < to ? 1 : 0), 0, dragged)
      // Keep every key the saved order already knew about, so dragging inside
      // one group never reshuffles another.
      const merged = [...next, ...order.filter((k) => !next.includes(k))].slice(0, MAX_KEYS)
      setOrder(merged)
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(merged))
      } catch {
        /* the session's own order is enough */
      }
    },
    [order]
  )

  const dragProps = useCallback(
    (key: RowKey, keys: readonly RowKey[]): DragProps => ({
      draggable: true,
      onDragStart: (e) => {
        setDragKey(key)
        e.dataTransfer.effectAllowed = 'move'
        try {
          e.dataTransfer.setData('text/plain', key)
        } catch {
          /* Firefox insists on data being set; anything else is fine without it */
        }
      },
      onDragOver: (e) => {
        if (!dragKey || dragKey === key || !keys.includes(dragKey)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const side = keys.indexOf(dragKey) < keys.indexOf(key) ? 'after' : 'before'
        setOver((cur) => (cur?.key === key && cur.side === side ? cur : { key, side }))
      },
      onDragLeave: () => setOver((cur) => (cur?.key === key ? null : cur)),
      onDrop: (e) => {
        e.preventDefault()
        if (dragKey) move(dragKey, key, keys)
        setDragKey(null)
        setOver(null)
      },
      onDragEnd: () => {
        setDragKey(null)
        setOver(null)
      }
    }),
    [dragKey, move]
  )

  return useMemo(() => ({ sort, dragKey, over, dragProps }), [sort, dragKey, over, dragProps])
}
