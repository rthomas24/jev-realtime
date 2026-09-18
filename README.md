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

- **Live data stream** — your own [Alpaca](https://alpaca.markets/) Market Data key. The free plan streams IEX prints and quotes in real time and crypto prints and quotes around the clock (a second socket on the same key); `sip` needs the paid plan; `test` streams a fake symbol (`FAKEPACA`) around the clock so the whole path can be watched with the market closed. The same key serves the polled snapshots and bars.
- **TypeSafe key** — for Jev. Every check is one request with every symbol's questions in it (fan-out); output tokens are free and input is a few thousand tokens per call.

## Crypto

An agent is either stocks or crypto (chosen when it is created; one book, one kind of thing in it). Crypto agents watch spot pairs — type `BTC`, `eth`, `SOL/USD` or `BTC-USD`; they come out as `BTC/USD` — and differ from stock agents in exactly the ways the market does:

- **No key needed for prices.** Crypto snapshots and bars come from Alpaca's public crypto endpoints (`data.alpaca.markets/v1beta3/crypto/us`), which answer without an API key, so a crypto agent runs on a fresh install with nothing entered, polled every couple of seconds. Add your free Alpaca key and the same key opens the crypto WebSocket for a real one-second tape (every print, every quote, the taker side).
- **Around the clock.** No open, no close, no flatten time, no entry window. The stop, target, trail and re-entry cooldown apply as for stocks; the day-loss lock still resets on the ET date.
- **Instant settlement.** Sale proceeds are spendable on the next tick; stocks rehearse T+1 as a cash account would.
- **Fractional units.** A $2,500 position in BTC is `0.03…` BTC; the paper book carries quantities to six decimals.

Why Alpaca for crypto (researched 2026-09-17): it is the one free source that is keyless for polling, real-time on the free key for streaming, US-accessible, and already the app's only market-data vendor — one wire format, one symbol list per request, one snapshot shape. Coinbase's and Kraken's public sockets are also free but would be a second vendor for the same numbers; Binance is geo-fenced; CoinGecko is minutes-old polled data on a small quota.

## Layout

- `src/shared` — pure types and rules (`realtimeAgents.ts` is the contract; `ledger.ts` the paper book; `marketTime.ts` the ET clock)
- `src/core` — Electron-free engine: `realtime/{situation,policy,tick}.ts` (describe → ask → compose → book), `market/{tape,alpacaStream,alpaca,alpacaCrypto,indicators}.ts`, `broker/paper.ts`
- `src/main` — the Electron host: `realtime/RealtimeEngine.ts` (one timer chain per agent, one WebSocket per asset class, the price stream for the page), encrypted key stores, IPC
- `src/renderer` — the dashboard: `RealtimeChart` (the hero), `DecisionPanel`, `Feed`
- `scripts` — the checks

## Not advice, and paper only

This is a paper-trading experiment: it simulates fills at real quotes and never places an order anywhere — no exchange, no wallet, no broker. Nothing it does or says is investment advice. Market data comes from Alpaca (your own key, or its public crypto endpoints) under Alpaca's terms; model answers come from your own TypeSafe key under TypeSafe's.

## License

MIT — see [LICENSE](LICENSE).
