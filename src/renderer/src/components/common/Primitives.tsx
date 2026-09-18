import type { JSX, ReactNode } from 'react'
import { cn } from '@renderer/lib/format'

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-6 py-10 fade-in', className)}>
      {icon && <div className="mb-3.5 h-11 w-11 rounded-xl inset flex items-center justify-center text-muted">{icon}</div>}
      <p className="text-md font-medium">{title}</p>
      {body !== undefined && <p className="text-sm text-muted mt-1 max-w-[46ch] leading-relaxed">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function SectionHead({ title, hint, right, className }: { title: string; hint?: ReactNode; right?: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex items-start gap-3 mb-2.5', className)}>
      <div className="min-w-0 flex-1">
        <h4 className="text-base font-semibold tracking-[-0.01em]">{title}</h4>
        {hint !== undefined && <p className="hint mt-0.5">{hint}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}
