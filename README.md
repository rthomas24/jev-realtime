# Jev Realtime

A small Electron desktop app: paper trading agents that watch a live tape and are decided every second by [TypeSafe's Jev](https://docs.typesafe.ai/), a System One model that returns typed judgments with probabilities instead of text.

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

- **Live data stream** — your own [Alpaca](https://alpaca.markets/) Market Data key. The free plan streams IEX prints and quotes in real time; `sip` needs the paid plan; `test` streams a fake symbol (`FAKEPACA`) around the clock so the whole path can be watched with the market closed. The same key serves the polled snapshots and bars.
- **TypeSafe key** — for Jev. Every check is one request with every symbol's questions in it (fan-out); output tokens are free and input is a few thousand tokens per call.

## Layout

- `src/shared` — pure types and rules (`realtimeAgents.ts` is the contract; `ledger.ts` the paper book; `marketTime.ts` the ET clock)
- `src/core` — Electron-free engine: `realtime/{situation,policy,tick}.ts` (describe → ask → compose → book), `market/{tape,alpacaStream,alpaca,indicators}.ts`, `broker/paper.ts`
- `src/main` — the Electron host: `realtime/RealtimeEngine.ts` (one timer chain per agent, one WebSocket per account, the price stream for the page), encrypted key stores, IPC
- `src/renderer` — the dashboard: `RealtimeChart` (the hero), `DecisionPanel`, `Feed`
- `scripts` — the checks

## Not advice, and paper only

This is a paper-trading experiment: it simulates fills at real quotes and never places an order anywhere. Nothing it does or says is investment advice. Market data comes from your own Alpaca key under Alpaca's terms; model answers come from your own TypeSafe key under TypeSafe's.

## License

MIT — see [LICENSE](LICENSE).
