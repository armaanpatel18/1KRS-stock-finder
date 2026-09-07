const fs = require("fs");
const { NseIndia } = require("stock-nse-india");

const universe = JSON.parse(
  fs.readFileSync("data/universe.json", "utf8")
);

const symbols = universe.symbols || [];

const nseIndia = new NseIndia();

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let value = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function vwap(candles) {
  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    volume += c.volume;
  }

  return volume ? pv / volume : null;
}

function normalize(data) {
  const rows = data?.data || data || [];

  return rows
    .map(c => {
      if (Array.isArray(c)) {
        return {
          timestamp: c[0],
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5] || 0)
        };
      }

      return {
        timestamp: c.timestamp || c.time || c.t,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      };
    })
    .filter(c =>
      Number.isFinite(c.close) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low)
    )
    .sort((a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp)
    );
}

async function scanSymbol(symbol) {
  try {
    const data = await nseIndia.getEquityChartHistoricalData(
      symbol,
      undefined,
      undefined,
      "Equity",
      "I",
      "5"
    );

    const candles = normalize(data);

    if (candles.length < 25) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason: "Insufficient intraday data"
      };
    }

    const closes = candles.map(c => c.close);

    const price = closes[closes.length - 1];

    const ema20 = ema(closes, 20);
    const rsi14 = rsi(closes, 14);
    const currentVwap = vwap(candles);

    const recent = candles.slice(-6);

    const recentHigh = Math.max(...recent.map(c => c.high));
    const recentLow = Math.min(...recent.map(c => c.low));

    const lastVolume =
      candles[candles.length - 1].volume;

    const previous = candles.slice(
      Math.max(0, candles.length - 21),
      candles.length - 1
    );

    const avgVolume =
      previous.reduce((sum, c) => sum + c.volume, 0) /
      Math.max(previous.length, 1);

    const relativeVolume =
      avgVolume > 0 ? lastVolume / avgVolume : null;

    const nearHigh =
      price >= recentHigh * 0.997;

    const nearLow =
      price <= recentLow * 1.003;

    let signal = "WATCH";
    let reason = "Mixed conditions";

    if (
      price > ema20 &&
      price > currentVwap &&
      rsi14 >= 52 &&
      rsi14 <= 70 &&
      relativeVolume >= 1.2 &&
      nearHigh
    ) {
      signal = "BUY";
      reason =
        "Price above EMA20/VWAP, positive RSI, strong volume and near recent high";
    } else if (
      price < ema20 &&
      price < currentVwap &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      relativeVolume >= 1.2 &&
      nearLow
    ) {
      signal = "SELL";
      reason =
        "Price below EMA20/VWAP, weak RSI, strong volume and near recent low";
    }

    return {
      symbol,
      signal,
      price: Number(price.toFixed(2)),
      ema20: ema20 ? Number(ema20.toFixed(2)) : null,
      rsi14: rsi14 ? Number(rsi14.toFixed(2)) : null,
      vwap: currentVwap
        ? Number(currentVwap.toFixed(2))
        : null,
      relative_volume: relativeVolume
        ? Number(relativeVolume.toFixed(2))
        : null,
      recent_high: Number(recentHigh.toFixed(2)),
      recent_low: Number(recentLow.toFixed(2)),
      entry: Number(price.toFixed(2)),
      stop_loss: Number(
        (signal === "SELL"
          ? price * 1.004
          : price * 0.996
        ).toFixed(2)
      ),
      target_1: Number(
        (signal === "SELL"
          ? price * 0.996
          : price * 1.004
        ).toFixed(2)
      ),
      target_2: Number(
        (signal === "SELL"
          ? price * 0.992
          : price * 1.008
        ).toFixed(2)
      ),
      reason
    };

  } catch (error) {
    console.error(`Failed: ${symbol}`, error.message);

    return {
      symbol,
      signal: "UNAVAILABLE",
      reason: "Data source unavailable"
    };
  }
}

async function main() {
  console.log(`Scanning ${symbols.length} NSE stocks...`);

  const stocks = [];

  for (const symbol of symbols) {
    console.log(`Scanning ${symbol}`);
    stocks.push(await scanSymbol(symbol));
  }

  const output = {
    updated_at: new Date().toISOString(),
    timezone: "Asia/Kolkata",
    market: "NSE",
    provider: "NSE chart data via stock-nse-india",
    interval: "5m",
    stocks
  };

  fs.writeFileSync(
    "data/intraday.json",
    JSON.stringify(output, null, 2)
  );

  console.log("Intraday data updated.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
