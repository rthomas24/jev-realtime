import type { ChoiceQuestion, NoulQuestion, Questions, ScoreQuestion, SystemOneResult } from '@typesafe-ai/sdk'

/**
 * The seam to the System One model. `runRealtimeTick` is written against
 * `Decider`, so the check script drives it with a scripted one and the host
 * hands it `typesafeDecider(key)`. Keeps the SDK out of every other file.
 */
export type JevQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion
export type JevAnswers<Q extends Questions> = SystemOneResult<Q>['answers']

export interface DecideOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface Decider {
  /** The model id the host will name in logs and on the page. */
  readonly model: string
  decide<Q extends Questions>(state: Record<string, unknown>, questions: Q, opts: DecideOptions): Promise<{ answers: JevAnswers<Q>; usage: { input: number; output: number }; model: string }>
}

/** The real thing: one client per key, retries left to the SDK, one attempt's timeout = the tick budget. */
export async function typesafeDecider(apiKey: string, model = 'jev-latest'): Promise<Decider> {
  const { TypeSafeClient } = await import('@typesafe-ai/sdk')
  const client = new TypeSafeClient({ apiKey, defaultModel: model, logLevel: 'off', retry: { maxRetries: 1, backoffInitialMs: 250, backoffMaxMs: 1000 } })
  return {
    model,
    async decide(state, questions, opts) {
      const r = await client.systemOne({ state: state as never, questions }, { timeout: opts.timeoutMs, signal: opts.signal })
      return { answers: r.answers, usage: { input: r.usage.input_tokens, output: r.usage.output_tokens }, model: r.model }
    }
  }
}

/** Prove a key works and list what it can use — the settings page's Test button. */
export async function testTypesafeKey(apiKey: string): Promise<{ models: string[] }> {
  const { TypeSafeClient } = await import('@typesafe-ai/sdk')
  const client = new TypeSafeClient({ apiKey, logLevel: 'off', retry: { maxRetries: 0 } })
  const cards = await client.models.list({ timeout: 8000 })
  return { models: cards.map((c) => c.name) }
}
