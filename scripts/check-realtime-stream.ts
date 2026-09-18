/**
 * The live tape behind one-second decisions (2026-09-17): the wire format of
 * the market-data stream is read by a pure parser, and the tape turns prints
 * and quotes into the facts a tick needs — the last price, the touch, the
 * moves over 10 s / 60 s / 5 min, who is hitting the book, the recent prints.
 *
 * Run: `npm run check`
 */
import { alpacaErrorIsFatal, alpacaStreamUrl, parseAlpacaMessages } from '@core/market/alpacaStream'
import { coinbaseProductId, coinbaseSymbol, parseCoinbaseMessages } from '@core/market/coinbase'
import { SymbolTape, tapeQuote } from '@core/market/tape'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('— the wire —')
{
  const frame = JSON.stringify([
    { T: 'success', msg: 'connected' },
    { T: 'success', msg: 'authenticated' },
    { T: 'subscription', trades: ['NVDA'], quotes: ['NVDA', 'AAPL'] },
    { T: 't', S: 'NVDA', i: 1, x: 'V', p: 183.72, s: 100, t: '2026-09-16T14:10:00.250Z', c: ['@'], z: 'C' },
    { T: 'q', S: 'NVDA', bx: 'V', bp: 183.71, bs: 2, ax: 'V', ap: 183.75, as: 4, t: '2026-09-16T14:10:00.300Z' },
    { T: 'error', code: 406, msg: 'connection limit exceeded' },
    { T: 'b', S: 'NVDA', o: 1, h: 1, l: 1, c: 1, v: 1 }
  ])
  const m = parseAlpacaMessages(frame)
  check('every message type is recognised', m.map((x) => x.kind).join() === 'connected,authenticated,subscription,trade,quote,error,other', m.map((x) => x.kind).join())
  const t = m[3]
  check('a trade carries its instant, price and size', t.kind === 'trade' && t.symbol === 'NVDA' && t.trade.p === 183.72 && t.trade.s === 100 && t.trade.t === Date.parse('2026-09-16T14:10:00.250Z'))
  const q = m[4]
  check('a quote carries both sides with sizes', q.kind === 'quote' && q.quote.bid === 183.71 && q.quote.ask === 183.75 && q.quote.bidSize === 2 && q.quote.askSize === 4)
  check('an error carries its code, and 406 is fatal (operator has to act) while 500 is not', m[5].kind === 'error' && m[5].code === 406 && alpacaErrorIsFatal(406) && !alpacaErrorIsFatal(500))
  check('malformed frames yield nothing rather than throwing', parseAlpacaMessages('{not json').length === 0 && parseAlpacaMessages('null').length === 0)
  check('a single object frame is accepted too', parseAlpacaMessages(JSON.stringify({ T: 'success', msg: 'connected' }))[0]?.kind === 'connected')
  check('the feed picks the url', alpacaStreamUrl('iex') === 'wss://stream.data.alpaca.markets/v2/iex' && alpacaStreamUrl('test') === 'wss://stream.data.alpaca.markets/v2/test')
}

console.log('\n— the crypto wire (Coinbase Exchange, public) —')
{
  check('symbols map both ways: BTC/USD and BTC-USD', coinbaseProductId('BTC/USD') === 'BTC-USD' && coinbaseSymbol('BTC-USD') === 'BTC/USD' && coinbaseSymbol('eth-usd') === 'ETH/USD')
  const frames = [
    { type: 'subscriptions', channels: [{ name: 'matches', product_ids: ['BTC-USD'], account_ids: null }, { name: 'ticker', product_ids: ['BTC-USD', 'ETH-USD'], account_ids: null }] },
    { type: 'ticker', sequence: 136286070602, product_id: 'BTC-USD', price: '76653.76', open_24h: '76298.04', best_bid: '76653.76', best_bid_size: '0.00780927', best_ask: '76653.77', best_ask_size: '0.0421', side: 'buy', time: '2026-09-18T01:45:20.123456Z', trade_id: 1094404894, last_size: '0.00002149' },
    { type: 'last_match', trade_id: 1094404894, side: 'buy', size: '0.00002149', price: '76653.76', product_id: 'BTC-USD', sequence: 136286070602, time: '2026-09-18T01:45:20.123456Z' },
    { type: 'match', trade_id: 1094404895, side: 'sell', size: '0.00000032', price: '76653.75', product_id: 'BTC-USD', sequence: 136286070934, time: '2026-09-18T01:45:20.523456Z' },
    { type: 'heartbeat', product_id: 'BTC-USD', sequence: 1, last_trade_id: 1, time: '2026-09-18T01:45:21Z' },
    { type: 'error', message: 'Failed to subscribe', reason: 'NOPE-USD is not a valid product' }
  ].map((m) => parseCoinbaseMessages(JSON.stringify(m))[0])
  check('every message type is recognised', frames.map((x) => x.kind).join() === 'subscriptions,quote,trade,trade,heartbeat,error', frames.map((x) => x.kind).join())
  check('the subscription lists the pairs as the engine names them', frames[0].kind === 'subscriptions' && frames[0].symbols.join() === 'BTC/USD,ETH/USD')
  const q = frames[1]
  check('a ticker is the touch with sizes, numbers from strings', q.kind === 'quote' && q.symbol === 'BTC/USD' && q.quote.bid === 76653.76 && q.quote.ask === 76653.77 && q.quote.bidSize === 0.00780927 && q.quote.askSize === 0.0421 && q.quote.t === Date.parse('2026-09-18T01:45:20.123456Z'))
  const t = frames[3]
  check('a match is a print with its instant, price and fractional size', t.kind === 'trade' && t.symbol === 'BTC/USD' && t.trade.p === 76653.75 && t.trade.s === 0.00000032)
  check('an error carries its reason', frames[5].kind === 'error' && /NOPE-USD/.test(frames[5].message))
  check('malformed frames yield nothing rather than throwing', parseCoinbaseMessages('{not json').length === 0 && parseCoinbaseMessages('null').length === 0)
}

console.log('\n— the tape —')
{
  const t0 = Date.parse('2026-09-16T14:10:00.000Z')
  const tape = new SymbolTape('NVDA')
  check('an empty tape has no snapshot', tape.snapshot(t0) === null)
  // Five minutes of prints, one every 2 s, drifting up 1% then the last 60 s hit the bid.
  tape.setQuote({ t: t0 - 300_000, bid: 99.99, ask: 100.01, bidSize: 100, askSize: 100 })
  for (let s = 300; s > 60; s -= 2) {
    const p = 100 + ((300 - s) / 240) * 1
    tape.setQuote({ t: t0 - s * 1000, bid: p - 0.01, ask: p + 0.01, bidSize: 100, askSize: 100 })
    tape.trade({ t: t0 - s * 1000, p: p + 0.01, s: 50 }) // at the ask: buyers
  }
  for (let s = 60; s >= 0; s -= 2) {
    const p = 101 - ((60 - s) / 60) * 0.3
    tape.setQuote({ t: t0 - s * 1000, bid: p - 0.01, ask: p + 0.01, bidSize: 400, askSize: 100 })
    tape.trade({ t: t0 - s * 1000, p: p - 0.01, s: 80 }) // at the bid: sellers
  }
  const snap = tape.snapshot(t0)!
  const near = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-6
  check('last print and touch', near(snap.last, 100.69) && near(snap.bid, 100.69) && near(snap.ask, 100.71) && snap.bidSize === 400 && snap.askSize === 100, JSON.stringify({ last: snap.last, bid: snap.bid, ask: snap.ask }))
  check('spread in percent', snap.spreadPct !== null && Math.abs(snap.spreadPct - 0.0199) < 0.001, `${snap.spreadPct}`)
  check('10 s move is down (the last minute sells off), 60 s move is down 0.3%, 5 min move is up', snap.returns.s10 !== null && snap.returns.s10 < 0 && snap.returns.s60 !== null && Math.abs(snap.returns.s60 + 0.297) < 0.02 && snap.returns.m5 !== null && snap.returns.m5 > 0.6, JSON.stringify(snap.returns))
  check('the last minute is classified as sellers hitting the bid', snap.flow60.sellShares > snap.flow60.buyShares && snap.flow60.buyShares === 0 && snap.flow60.prints === 31, JSON.stringify(snap.flow60))
  check('pace and recent prints', snap.printsPerMinute >= 28 && snap.printsPerMinute <= 32 && snap.recent.length === 12 && snap.recent[11] === 100.69, `${snap.printsPerMinute}/min, ${snap.recent.length} recent`)
  check('the quote shape every consumer takes', (() => {
    const q = tapeQuote(snap)
    return q.symbol === 'NVDA' && near(q.last, 100.69) && near(q.bid ?? null, 100.69) && near(q.ask ?? null, 100.71) && q.ts === new Date(snap.updatedAt).toISOString()
  })())
  const later = tape.snapshot(t0 + 6 * 60_000)!
  check('after six quiet minutes the window is empty of prints and the moves are null, but the last print stands', later.returns.s60 === null && later.returns.m5 === null && later.flow60.prints === 0 && near(later.last, 100.69))
  const bad = new SymbolTape('X')
  bad.trade({ t: t0, p: 0, s: 1 })
  bad.trade({ t: t0, p: -1, s: 1 })
  check('junk prints are ignored', bad.snapshot(t0) === null)
  const quoteOnly = new SymbolTape('Q')
  quoteOnly.setQuote({ t: t0, bid: 10, ask: 10.02, bidSize: 1, askSize: 1 })
  check('a quote with no print yet reads as the mid', quoteOnly.snapshot(t0)!.last === 10.01)

  // A thin crypto pair: one print, then the book keeps moving. The stock rule keeps the print; the crypto rule follows the mid.
  const stock = new SymbolTape('X')
  const coin = new SymbolTape('BTC/USD', { markAtMid: true })
  for (const tp of [stock, coin]) {
    tp.setQuote({ t: t0 - 5000, bid: 99.9, ask: 100.1, bidSize: 1, askSize: 1 })
    tp.trade({ t: t0 - 4000, p: 100, s: 1 })
    tp.setQuote({ t: t0 - 1000, bid: 100.4, ask: 100.6, bidSize: 1, askSize: 1 })
  }
  check('a stock stays at its last print while the book moves', stock.snapshot(t0)!.last === 100 && stock.snapshot(t0)!.lastTradeAt === t0 - 4000)
  check('a crypto tape marks at the mid of a quote newer than the last print', Math.abs(coin.snapshot(t0)!.last - 100.5) < 1e-9 && coin.snapshot(t0)!.lastTradeAt === t0 - 1000, `${coin.snapshot(t0)!.last}`)
  coin.trade({ t: t0 - 500, p: 100.55, s: 1 })
  check('and goes back to the print once one is newer than the quote', coin.snapshot(t0)!.last === 100.55)
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
