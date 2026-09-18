/**
 * What the picker offers before anything is typed, and what it completes
 * from when no live asset list is available: the names people actually
 * watch. Curated, not exhaustive — the live list from the market-data key
 * covers the long tail. Pure and Node-free.
 */
export type AssetKind = 'stocks' | 'crypto'

export interface AssetInfo {
  symbol: string
  name: string
  kind: AssetKind
}

const S = (symbol: string, name: string): AssetInfo => ({ symbol, name, kind: 'stocks' })
const C = (symbol: string, name: string): AssetInfo => ({ symbol: `${symbol}/USD`, name, kind: 'crypto' })

/** The quick-pick chips, in the order they are shown. */
export const TOP_STOCKS: AssetInfo[] = [
  S('NVDA', 'NVIDIA'),
  S('AAPL', 'Apple'),
  S('TSLA', 'Tesla'),
  S('MSFT', 'Microsoft'),
  S('AMZN', 'Amazon'),
  S('META', 'Meta Platforms'),
  S('GOOGL', 'Alphabet'),
  S('AMD', 'Advanced Micro Devices'),
  S('PLTR', 'Palantir'),
  S('COIN', 'Coinbase'),
  S('SPY', 'S&P 500 ETF'),
  S('QQQ', 'Nasdaq-100 ETF')
]

export const TOP_CRYPTO: AssetInfo[] = [C('BTC', 'Bitcoin'), C('ETH', 'Ethereum'), C('SOL', 'Solana'), C('XRP', 'XRP'), C('DOGE', 'Dogecoin'), C('ADA', 'Cardano'), C('AVAX', 'Avalanche'), C('LINK', 'Chainlink')]

/** The built-in catalogue the picker completes from. */
export const POPULAR_ASSETS: AssetInfo[] = [
  ...TOP_STOCKS,
  S('AVGO', 'Broadcom'),
  S('BRK.B', 'Berkshire Hathaway'),
  S('JPM', 'JPMorgan Chase'),
  S('V', 'Visa'),
  S('MA', 'Mastercard'),
  S('UNH', 'UnitedHealth'),
  S('XOM', 'Exxon Mobil'),
  S('LLY', 'Eli Lilly'),
  S('JNJ', 'Johnson & Johnson'),
  S('WMT', 'Walmart'),
  S('PG', 'Procter & Gamble'),
  S('HD', 'Home Depot'),
  S('COST', 'Costco'),
  S('ORCL', 'Oracle'),
  S('NFLX', 'Netflix'),
  S('CRM', 'Salesforce'),
  S('ADBE', 'Adobe'),
  S('PEP', 'PepsiCo'),
  S('KO', 'Coca-Cola'),
  S('BAC', 'Bank of America'),
  S('CSCO', 'Cisco'),
  S('TMO', 'Thermo Fisher'),
  S('ABBV', 'AbbVie'),
  S('MRK', 'Merck'),
  S('CVX', 'Chevron'),
  S('MCD', "McDonald's"),
  S('ACN', 'Accenture'),
  S('INTU', 'Intuit'),
  S('QCOM', 'Qualcomm'),
  S('TXN', 'Texas Instruments'),
  S('AMGN', 'Amgen'),
  S('CAT', 'Caterpillar'),
  S('GE', 'GE Aerospace'),
  S('IBM', 'IBM'),
  S('DIS', 'Walt Disney'),
  S('NKE', 'Nike'),
  S('MSTR', 'Strategy'),
  S('HOOD', 'Robinhood'),
  S('SOFI', 'SoFi'),
  S('RIVN', 'Rivian'),
  S('NIO', 'NIO'),
  S('F', 'Ford'),
  S('GM', 'General Motors'),
  S('UBER', 'Uber'),
  S('LYFT', 'Lyft'),
  S('ABNB', 'Airbnb'),
  S('SHOP', 'Shopify'),
  S('SQ', 'Block'),
  S('PYPL', 'PayPal'),
  S('SNAP', 'Snap'),
  S('PINS', 'Pinterest'),
  S('SPOT', 'Spotify'),
  S('ROKU', 'Roku'),
  S('ZM', 'Zoom'),
  S('CRWD', 'CrowdStrike'),
  S('PANW', 'Palo Alto Networks'),
  S('SNOW', 'Snowflake'),
  S('DDOG', 'Datadog'),
  S('NET', 'Cloudflare'),
  S('MDB', 'MongoDB'),
  S('OKTA', 'Okta'),
  S('ZS', 'Zscaler'),
  S('ARM', 'Arm Holdings'),
  S('SMCI', 'Super Micro Computer'),
  S('MU', 'Micron'),
  S('INTC', 'Intel'),
  S('TSM', 'Taiwan Semiconductor'),
  S('ASML', 'ASML'),
  S('LRCX', 'Lam Research'),
  S('AMAT', 'Applied Materials'),
  S('KLAC', 'KLA'),
  S('MRVL', 'Marvell'),
  S('ON', 'onsemi'),
  S('ENPH', 'Enphase'),
  S('FSLR', 'First Solar'),
  S('IONQ', 'IonQ'),
  S('RGTI', 'Rigetti'),
  S('BA', 'Boeing'),
  S('LMT', 'Lockheed Martin'),
  S('RTX', 'RTX'),
  S('DE', 'Deere'),
  S('HON', 'Honeywell'),
  S('UPS', 'UPS'),
  S('FDX', 'FedEx'),
  S('SBUX', 'Starbucks'),
  S('CMG', 'Chipotle'),
  S('LULU', 'Lululemon'),
  S('TGT', 'Target'),
  S('LOW', "Lowe's"),
  S('GS', 'Goldman Sachs'),
  S('MS', 'Morgan Stanley'),
  S('C', 'Citigroup'),
  S('WFC', 'Wells Fargo'),
  S('SCHW', 'Charles Schwab'),
  S('BLK', 'BlackRock'),
  S('IWM', 'Russell 2000 ETF'),
  S('DIA', 'Dow Jones ETF'),
  S('VTI', 'Total Stock Market ETF'),
  S('VOO', 'S&P 500 ETF (Vanguard)'),
  S('GLD', 'Gold ETF'),
  S('SLV', 'Silver ETF'),
  S('TLT', '20+ Year Treasury ETF'),
  S('XLF', 'Financials ETF'),
  S('XLK', 'Technology ETF'),
  S('XLE', 'Energy ETF'),
  S('ARKK', 'ARK Innovation ETF'),
  S('TQQQ', 'Nasdaq-100 3x ETF'),
  S('SOXL', 'Semiconductors 3x ETF'),
  ...TOP_CRYPTO,
  C('DOT', 'Polkadot'),
  C('LTC', 'Litecoin'),
  C('BCH', 'Bitcoin Cash'),
  C('UNI', 'Uniswap'),
  C('AAVE', 'Aave'),
  C('SHIB', 'Shiba Inu'),
  C('PEPE', 'Pepe'),
  C('SUI', 'Sui'),
  C('TRX', 'TRON'),
  C('XLM', 'Stellar'),
  C('ATOM', 'Cosmos'),
  C('USDT', 'Tether')
]

/** The display symbol of a crypto pair: `BTC/USD` → `BTC`. Stocks are unchanged. */
export function shortSymbol(a: Pick<AssetInfo, 'symbol' | 'kind'>): string {
  return a.kind === 'crypto' ? a.symbol.split('/')[0] : a.symbol
}

/**
 * Matches for what was typed, best first: symbols that start with the
 * query, then symbols containing it, then names containing it. A crypto
 * pair matches on its base coin too, so `bt` finds `BTC/USD`.
 */
export function searchAssets(query: string, assets: readonly AssetInfo[], limit = 8): AssetInfo[] {
  const q = query.trim().toUpperCase().replace(/[\s_-]+/g, '')
  if (!q) return []
  const scored: { a: AssetInfo; score: number }[] = []
  for (const a of assets) {
    const sym = shortSymbol(a).replace('.', '')
    const full = a.symbol.replace(/[/.]/g, '')
    const name = a.name.toUpperCase()
    let score = 0
    if (sym === q || full === q) score = 5
    else if (sym.startsWith(q) || full.startsWith(q)) score = 4
    else if (name.startsWith(q)) score = 3
    else if (sym.includes(q)) score = 2
    else if (name.includes(q)) score = 1
    if (score) scored.push({ a, score })
  }
  return scored
    .sort((x, y) => y.score - x.score || shortSymbol(x.a).length - shortSymbol(y.a).length || x.a.symbol.localeCompare(y.a.symbol))
    .slice(0, limit)
    .map((x) => x.a)
}

/** The built-in catalogue plus a live list, live names winning, no duplicates. */
export function mergeAssets(builtIn: readonly AssetInfo[], live: readonly AssetInfo[]): AssetInfo[] {
  const bySymbol = new Map<string, AssetInfo>()
  for (const a of builtIn) bySymbol.set(`${a.kind}:${a.symbol}`, a)
  for (const a of live) {
    const k = `${a.kind}:${a.symbol}`
    const had = bySymbol.get(k)
    bySymbol.set(k, had && !a.name ? had : a)
  }
  return [...bySymbol.values()]
}
