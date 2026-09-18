# Jev Realtime

A small Electron desktop app: paper trading agents that watch a live tape — US stocks or crypto — and are decided every second by [TypeSafe's Jev](https://docs.typesafe.ai/), a System One model that returns typed judgments with probabilities instead of text.

Extracted from the Real time page of HarborBots, a larger trading-agent app by the same author. The engine trades, the model decides — and the model only answers narrow, atomic questions (direction over the next few minutes, is the price extended, how clean is the setup, is the trend intact, is it reversing) that code composes into buy / sell / hold under the operator's thresholds. Stops, targets, trails, the flatten time, the entry window and the day-loss lock are enforced in code on every tick, before the model is asked.

## Run

```bash
npm install
npm run dev        # the app, with main + preload rebuilt on change
npm run typecheck
npm run check      # the tick and the tape, driven by a scripted model
npm run build      # out/
npm run dist:win   # installer in dist/
```

## Keys

Both are entered in the app's bottom rows and stored encrypted with the OS keychain on this computer. Nothing goes in `.env`.

- **Live data stream** — your own [Alpaca](https://alpaca.markets/) Market Data key, for stocks. The free plan streams IEX prints and quotes in real time; `sip` needs the paid plan; `test` streams a fake symbol (`FAKEPACA`) around the clock so the whole path can be watched with the market closed. The same key serves the polled snapshots and bars. Crypto needs no key at all (see below).
- **TypeSafe key** — for Jev. Every check is one request with every symbol's questions in it (fan-out); output tokens are free and input is about a thousand tokens per symbol per call, billed at TypeSafe's list price of $0.042 per million input tokens.

## What the model is told

Every check hands Jev one state and asks every question about it at once. The state is what a trader at the desk would have in front of them, with every number already worked out in code and handed over as a described fact — Jev reads numbers as text and is weak at comparing them, so it is never asked to do arithmetic:

- **The tape**, in words: the last print and how old it is, the touch and which side is stacked, the moves over the last ten seconds, minute and five minutes, who is hitting the book, and the pace.
- **The bars and the trend**: moves over the last 5 / 15 / 30 / 60 minutes, the shape of the last few candles, volume against its usual pace, the opening range, the daily trend and RSI in words, the typical daily range.
- **The position**, when there is one: how long it has been held, what it is worth, the high since entry, how far the price is from that high, and where the stop and target sit relative to the price now.
- **The book**: its paper size, how much of it is at work and in what, and how the day is going.
- **What it has already done here today**: every round trip closed in this symbol — the percentage, how long it was held, how long ago it closed, and how it ended (stopped out, hit the target, or closed by the model) — plus the tally, counted in code.
- **How its own last reads aged**: the judgments it gave earlier on this symbol, and what the price did after each one.

It is not told the stop and target percentages, the cadence, or the flatten time. Code enforces those and never asks about them, and unrelated material in the state costs accuracy.

## The judgments, and the gates

Each is its own question with its own probability, composed in code. A flat symbol is asked five, a held one three; they go in one request and are evaluated in parallel.

| Judgment | Type | Asked when | The gate in code |
| --- | --- | --- | --- |
| Direction over the next few minutes | Choice (up / down / flat) | always | buy needs P(up) ≥ `buyThreshold`; a held position is closed at P(down) ≥ `sellThreshold` |
| Is the price extended — would buying be chasing? | Noul | flat | refused at ≥ `maxExtended` |
| How clean is the setup? | Score (chop / mixed / clean) | flat | needs ≥ `minSetup` |
| How well is this symbol carrying a move today? | Score (chopping / mixed / trending) | flat | needs ≥ `minRegime` |
| Would this repeat an entry that already failed here today? | Noul | flat | refused at ≥ `maxRepeat` |
| Is it reversing against the position right now? | Noul | holding | closes it at ≥ `reversalThreshold` |
| Is the move that justified the entry still intact? | Noul | holding | closes it at ≤ 1 − `sellThreshold` |

The panel shows every one of them as a bar with its threshold marked, and then the checks in the order the engine applied them, so a refusal reads as a sentence: `up 76% ≥ 70% ✓ → extended 21% < 60% ✓ → setup 1.34 ≥ 1.0 ✓ → carrying 0.55 ≥ 0.8 ✗ → HOLD`.

## What a check costs, and what is not asked

Jev is priced per input token, so the bill is the number of calls times the size of each one. Both are kept down on purpose, and both are shown: each row's stats line reads `calls · tokens · $ today · $ all time`, the header pill adds every agent up, and every tick in `ticks.jsonl` carries its `usage` and the versioned model id that answered.

- **The quiet band.** The model is asked only when a price has moved at least `askMinMovePct` (default 0.02%) since it last saw it, or `askAtLeastEverySec` (default 10 s) has passed, or what is held has changed. The same situation gets the same answer — TypeSafe's models are self-consistent by design — so asking again inside the noise buys nothing. On a one-second cadence in a calm tape this is most of the checks; each one is logged as `quiet.band` with the last verdict standing, and the engine's stops, targets and trail still run on every tick. Set the band to 0 to ask on every check.
- **Only what a judgment reads.** The state carries the tape in words (the touch, who is hitting the book, the last seconds' moves), the bars, the trend and the position — never the engine's stop and target numbers, the cadence or the flatten time, which are enforced in code and would only be context rot; raw print lists are left out because the model reads numbers as text.
- **No second billing.** A request that times out is not retried — the attempt may already have been answered and charged, and its answer is stale by the time a retry lands; the next tick asks again with fresher prices. Agents on a cadence of five seconds or less get no retries at all; slower ones get one, for a 429 or a 5xx, with the SDK's backoff.

## Crypto

An agent is either stocks or crypto (chosen when it is created; one book, one kind of thing in it). Crypto agents watch spot pairs — type `BTC`, `eth`, `SOL/USD` or `BTC-USD`; they come out as `BTC/USD` — and differ from stock agents in exactly the ways the market does:

- **No key needed, and a real tape.** Crypto comes from Coinbase Exchange's public market data: the WebSocket feed (`ws-feed.exchange.coinbase.com`) streams every print and the best bid and ask with no authentication, and the REST API serves tickers and 5-minute / daily candles the same way. A crypto agent therefore runs on a fresh install with nothing entered and still sees a one-second tape; the Alpaca key is for stocks only. A pair whose book has moved since its last print is marked at the mid, so a thin pair still moves with its market.
- **Around the clock.** No open, no close, no flatten time, no entry window. The stop, target and trail apply as for stocks; the day-loss lock still resets on the ET date.
- **Instant settlement.** Sale proceeds are spendable on the next tick; stocks rehearse T+1 as a cash account would.
- **Fractional units.** A $2,500 position in BTC is `0.03…` BTC; the paper book carries quantities to six decimals.

Why Coinbase for crypto (researched and measured 2026-09-17): its public feed needs no key and delivered dozens of BTC-USD prints in ten seconds; its public REST has candles and 400+ USD pairs. Alpaca's crypto data is keyless for polling but its socket needs a key, and Alpaca's own venue is thin (a few dozen BTC prints a day). Kraken's public socket is comparable but Coinbase is the larger US venue. Binance is geo-fenced; CoinGecko is minutes-old polled data on a small quota. Coinbase's MCP server and Advanced Trade API are for accounts and orders; this app only reads public market data and never places an order.

## Layout

- `src/shared` — pure types and rules (`realtimeAgents.ts` is the contract; `ledger.ts` the paper book; `marketTime.ts` the ET clock)
- `src/core` — Electron-free engine: `realtime/{situation,policy,tick}.ts` (describe → ask → compose → book), `market/{tape,alpacaStream,alpaca,coinbase,indicators}.ts`, `broker/paper.ts`
- `src/main` — the Electron host: `realtime/RealtimeEngine.ts` (one timer chain per agent, one WebSocket per asset class, the price stream for the page), encrypted key stores, IPC
- `src/renderer` — the dashboard: `RealtimeChart` (the hero), `DecisionPanel`, `Feed`
- `scripts` — the checks

## Not advice, and paper only

This is a paper-trading experiment: it simulates fills at real quotes and never places an order anywhere — no exchange, no wallet, no broker. Nothing it does or says is investment advice. Stock data comes from your own Alpaca key under Alpaca's terms; crypto data from Coinbase Exchange's public market data under Coinbase's; model answers come from your own TypeSafe key under TypeSafe's.

## License

MIT — see [LICENSE](LICENSE).
