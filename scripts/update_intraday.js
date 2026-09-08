const fs = require("fs");
const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

const SYMBOLS = [
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "ITC",
  "BEL",
  "LT",
  "SUNPHARMA",
  "MARUTI",
  "HINDUNILVR",
  "RELIANCE",
  "BHARTIARTL",
  "AXISBANK",
  "KOTAKBANK",
  "TITAN",
  "M&M",
  "NTPC",
  "POWERGRID",
  "COALINDIA"
];

const CAPITAL = 1000;

function indiaDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day)
  };
}

function indiaSessionRange() {
  const { year, month, day } = indiaDateParts();

  // NSE:
  // 09:15 IST = 03:45 UTC
  // 15:15 IST = 09:45 UTC
  //
  // We intentionally stop at 15:15 IST to avoid
  // closing-auction effects.

  return {
    start: new Date(
      Date.UTC(year, month - 1, day, 3, 45, 0)
    ),
    end: new Date(
      Date.UTC(year, month - 1, day, 9, 45, 0)
    )
  };
}

function timestampToMs(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  // Unix seconds
  if (n < 1e12) {
    return n * 1000;
  }

  // Unix milliseconds
  return n;
}

function normalizeCandles(response) {
  if (!response) return [];

  const data = Array.isArray(response.data)
    ? response.data
    : [];

  const candles = [];

  for (const c of data) {
    if (!c) continue;

    let candle = null;

    // stock-nse-india chart format
    if (
      typeof c === "object" &&
      !Array.isArray(c)
    ) {
      candle = {
        time: timestampToMs(c.time ?? c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume)
      };
    }

    // Generic array format
    else if (Array.isArray(c)) {
      candle = {
        time: timestampToMs(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5])
      };
    }

    if (!candle) continue;

    if (!Number.isFinite(candle.time)) continue;
    if (!Number.isFinite(candle.open)) continue;
    if (!Number.isFinite(candle.high)) continue;
    if (!Number.isFinite(candle.low)) continue;
    if (!Number.isFinite(candle.close)) continue;

    if (
      candle.high < candle.low ||
      candle.close <= 0 ||
      candle.open <= 0
    ) {
      continue;
    }

    if (!Number.isFinite(candle.volume)) {
      candle.volume = null;
    }

    candles.push(candle);
  }

  candles.sort((a, b) => a.time - b.time);

  return candles;
}

function filterSession(candles) {
  const { start, end } = indiaSessionRange();

  return candles.filter(c => {
    const time = new Date(c.time);
    return time >= start && time <= end;
  });
}

function normalizeVolume(candles) {
  const values = candles.map(c => c.volume);

  const valid = values.filter(v =>
    Number.isFinite(v) && v >= 0
  );

  if (valid.length < 2) {
    return candles;
  }

  // Detect cumulative volume.
  let increasing = 0;

  for (let i = 1; i < valid.length; i++) {
    if (valid[i] >= valid[i - 1]) {
      increasing++;
    }
  }

  const mostlyIncreasing =
    increasing / (valid.length - 1) >= 0.8;

  if (!mostlyIncreasing) {
    return candles;
  }

  let previous = null;

  for (const candle of candles) {
    const current = candle.volume;

    if (!Number.isFinite(current)) {
      candle.volume = null;
      continue;
    }

    if (previous === null) {
      candle.volume = null;
    } else {
      const difference = current - previous;

      candle.volume =
        difference >= 0 ? difference : null;
    }

    previous = current;
  }

  return candles;
}

function average(values) {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) return null;

  return (
    valid.reduce((sum, value) => sum + value, 0) /
    valid.length
  );
}

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier +
      result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function vwap(candles) {
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    if (
      !Number.isFinite(candle.volume) ||
      candle.volume <= 0
    ) {
      continue;
    }

    const typicalPrice =
      (candle.high +
        candle.low +
        candle.close) / 3;

    cumulativePV +=
      typicalPrice * candle.volume;

    cumulativeVolume += candle.volume;
  }

  if (cumulativeVolume <= 0) {
    return null;
  }

  return cumulativePV / cumulativeVolume;
}

function relativeVolume(candles) {
  if (candles.length < 21) {
    return null;
  }

  const latest = candles[candles.length - 1];

  if (!Number.isFinite(latest.volume)) {
    return null;
  }

  const previous = candles
    .slice(-21, -1)
    .map(c => c.volume)
    .filter(v =>
      Number.isFinite(v) && v > 0
    );

  if (previous.length < 10) {
    return null;
  }

  const avgVolume = average(previous);

  if (
    !Number.isFinite(avgVolume) ||
    avgVolume <= 0
  ) {
    return null;
  }

  const value =
    latest.volume / avgVolume;

  // Extremely large values usually indicate
  // bad/cumulative volume data.
  if (!Number.isFinite(value) || value > 20) {
    return null;
  }

  return value;
}

function getRecentHigh(candles, count = 20) {
  const values = candles
    .slice(-count)
    .map(c => c.high)
    .filter(Number.isFinite);

  return values.length
    ? Math.max(...values)
    : null;
}

function getRecentLow(candles, count = 20) {
  const values = candles
    .slice(-count)
    .map(c => c.low)
    .filter(Number.isFinite);

  return values.length
    ? Math.min(...values)
    : null;
}

function getQuotePrice(details) {
  const priceInfo = details?.priceInfo;

  const candidates = [
    priceInfo?.lastPrice,
    priceInfo?.lastTradedPrice,
    details?.lastPrice,
    details?.lastTradedPrice
  ];

  for (const value of candidates) {
    const number = Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return null;
}

function priceGapPercent(chartPrice, quotePrice) {
  if (
    !Number.isFinite(chartPrice) ||
    !Number.isFinite(quotePrice) ||
    quotePrice <= 0
  ) {
    return null;
  }

  return (
    Math.abs(chartPrice - quotePrice) /
    quotePrice
  ) * 100;
}

function positionSizing(entry, stop, target1, target2) {
  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(stop)
  ) {
    return {
      capital: null,
      quantity: 0,
      risk: null,
      target1_profit: null,
      target2_profit: null,
      risk_reward_1: null,
      risk_reward_2: null
    };
  }

  const quantity = Math.floor(
    CAPITAL / entry
  );

  if (quantity < 1) {
    return {
      capital: 0,
      quantity: 0,
      risk: null,
      target1_profit: null,
      target2_profit: null,
      risk_reward_1: null,
      risk_reward_2: null
    };
  }

  const capital = quantity * entry;

  const risk =
    Math.abs(entry - stop) * quantity;

  const target1Profit =
    Math.abs(target1 - entry) * quantity;

  const target2Profit =
    Math.abs(target2 - entry) * quantity;

  const riskReward1 =
    risk > 0
      ? target1Profit / risk
      : null;

  const riskReward2 =
    risk > 0
      ? target2Profit / risk
      : null;

  return {
    capital: Number(capital.toFixed(2)),
    quantity,
    risk: Number(risk.toFixed(2)),
    target1_profit: Number(
      target1Profit.toFixed(2)
    ),
    target2_profit: Number(
      target2Profit.toFixed(2)
    ),
    risk_reward_1:
      riskReward1 === null
        ? null
        : Number(riskReward1.toFixed(2)),
    risk_reward_2:
      riskReward2 === null
        ? null
        : Number(riskReward2.toFixed(2))
  };
}

async function getChart(
  symbol,
  interval
) {
  // Request enough history for indicator warm-up.
  // We deliberately let the package retrieve chart
  // data and then filter it to today's NSE session.

  return await nse.getEquityChartHistoricalData(
    symbol,
    undefined,
    undefined,
    "Equity",
    "I",
    String(interval)
  );
}

async function scanStock(symbol) {
  try {
    const [
      chart5Response,
      chart15Response,
      details
    ] = await Promise.all([
      getChart(symbol, 5),
      getChart(symbol, 15),
      nse.getEquityDetails(symbol)
    ]);

    const all5 = normalizeCandles(
      chart5Response
    );

    const all15 = normalizeCandles(
      chart15Response
    );

    const candles5 = normalizeVolume(
      filterSession(all5)
    );

    const candles15 = filterSession(all15);

    const quotePrice =
      getQuotePrice(details);

    const latest =
      candles5[candles5.length - 1];

    const chartPrice =
      latest?.close ?? null;

    // If we don't have current-session candles yet,
    // don't call this an API failure.
    if (!candles5.length) {
      return {
        symbol,
        signal: "WAIT",
        reason:
          "No current-session 5m candles yet",
        price: quotePrice,
        quote_price: quotePrice,
        ema20: null,
        rsi14: null,
        vwap: null,
        relative_volume: null,
        trend_15m: "BUILDING",
        recent_high: null,
        recent_low: null,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        capital: null,
        quantity: 0,
        risk: null,
        target1_profit: null,
        target2_profit: null,
        risk_reward_1: null,
        risk_reward_2: null,
        volume_confirmed: false
      };
    }

    // Quote validation
    if (
      Number.isFinite(chartPrice) &&
      Number.isFinite(quotePrice)
    ) {
      const gap =
        priceGapPercent(
          chartPrice,
          quotePrice
        );

      // More than 3% difference is suspicious.
      if (gap !== null && gap > 3) {
        return {
          symbol,
          signal: "UNAVAILABLE",
          reason:
            "Chart price differs too much from live quote",
          price: null,
          quote_price: quotePrice,
          ema20: null,
          rsi14: null,
          vwap: null,
          relative_volume: null,
          trend_15m: "UNKNOWN",
          recent_high: null,
          recent_low: null,
          entry: null,
          stop_loss: null,
          target_1: null,
          target_2: null,
          capital: null,
          quantity: 0,
          risk: null,
          target1_profit: null,
          target2_profit: null,
          risk_reward_1: null,
          risk_reward_2: null,
          price_gap_pct: Number(
            gap.toFixed(2)
          ),
          volume_confirmed: false
        };
      }
    }

    // Use live quote as the displayed/current price
    // when available.
    const price =
      Number.isFinite(quotePrice)
        ? quotePrice
        : chartPrice;

    const closes5 =
      candles5.map(c => c.close);

    const ema20 =
      closes5.length >= 20
        ? ema(closes5, 20)
        : null;

    const rsi14 =
      closes5.length >= 15
        ? rsi(closes5, 14)
        : null;

    const currentVwap =
      vwap(candles5);

    const relVol =
      relativeVolume(candles5);

    const recentHigh =
      getRecentHigh(candles5);

    const recentLow =
      getRecentLow(candles5);

    // 15-minute trend
    let trend15 = "BUILDING";

    if (candles15.length >= 20) {
      const closes15 =
        candles15.map(c => c.close);

      const ema15 =
        ema(closes15, 20);

      const last15 =
        closes15[closes15.length - 1];

      if (
        Number.isFinite(ema15) &&
        Number.isFinite(last15)
      ) {
        if (last15 > ema15) {
          trend15 = "BULLISH";
        } else if (last15 < ema15) {
          trend15 = "BEARISH";
        } else {
          trend15 = "NEUTRAL";
        }
      }
    }

    // Not enough candles yet.
    if (candles5.length < 25) {
      return {
        symbol,
        signal: "WAIT",
        reason:
          `Building 5m intraday history (${candles5.length}/25 candles)`,
        price,
        quote_price: quotePrice,
        ema20,
        rsi14,
        vwap: currentVwap,
        relative_volume: relVol,
        trend_15m: trend15,
        recent_high: recentHigh,
        recent_low: recentLow,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        capital: null,
        quantity: 0,
        risk: null,
        target1_profit: null,
        target2_profit: null,
        risk_reward_1: null,
        risk_reward_2: null,
        volume_confirmed:
          Number.isFinite(relVol)
      };
    }

    // We need 15m confirmation before trading.
    if (candles15.length < 20) {
      return {
        symbol,
        signal: "WAIT",
        reason:
          `Building 15m confirmation (${candles15.length}/20 candles)`,
        price,
        quote_price: quotePrice,
        ema20,
        rsi14,
        vwap: currentVwap,
        relative_volume: relVol,
        trend_15m: trend15,
        recent_high: recentHigh,
        recent_low: recentLow,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        capital: null,
        quantity: 0,
        risk: null,
        target1_profit: null,
        target2_profit: null,
        risk_reward_1: null,
        risk_reward_2: null,
        volume_confirmed:
          Number.isFinite(relVol)
      };
    }

    // Volume is mandatory for a trading signal.
    if (!Number.isFinite(relVol)) {
      return {
        symbol,
        signal: "WATCH",
        reason:
          "Volume confirmation unavailable",
        price,
        quote_price: quotePrice,
        ema20,
        rsi14,
        vwap: currentVwap,
        relative_volume: null,
        trend_15m: trend15,
        recent_high: recentHigh,
        recent_low: recentLow,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        capital: null,
        quantity: 0,
        risk: null,
        target1_profit: null,
        target2_profit: null,
        risk_reward_1: null,
        risk_reward_2: null,
        volume_confirmed: false
      };
    }

    const nearHigh =
      Number.isFinite(recentHigh) &&
      price >= recentHigh * 0.997;

    const nearLow =
      Number.isFinite(recentLow) &&
      price <= recentLow * 1.003;

    const buy =
      price > ema20 &&
      price > currentVwap &&
      rsi14 >= 52 &&
      rsi14 <= 70 &&
      relVol >= 1.2 &&
      nearHigh &&
      trend15 === "BULLISH";

    const sell =
      price < ema20 &&
      price < currentVwap &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      relVol >= 1.2 &&
      nearLow &&
      trend15 === "BEARISH";

    let signal = "WATCH";
    let reason = "Mixed conditions";

    if (buy) {
      signal = "BUY";
      reason =
        "5m bullish + VWAP/EMA confirmation + volume + 15m bullish";
    } else if (sell) {
      signal = "SELL";
      reason =
        "5m bearish + VWAP/EMA confirmation + volume + 15m bearish";
    }

    let entry = null;
    let stopLoss = null;
    let target1 = null;
    let target2 = null;

    if (signal === "BUY") {
      entry = price;
      stopLoss = price * 0.996;
      target1 = price * 1.004;
      target2 = price * 1.008;
    }

    if (signal === "SELL") {
      entry = price;
      stopLoss = price * 1.004;
      target1 = price * 0.996;
      target2 = price * 0.992;
    }

    const sizing =
      signal === "BUY" ||
      signal === "SELL"
        ? positionSizing(
            entry,
            stopLoss,
            target1,
            target2
          )
        : positionSizing(
            null,
            null,
            null,
            null
          );

    return {
      symbol,
      signal,
      reason,

      price: Number(price.toFixed(2)),

      quote_price:
        Number.isFinite(quotePrice)
          ? Number(quotePrice.toFixed(2))
          : null,

      ema20:
        Number.isFinite(ema20)
          ? Number(ema20.toFixed(2))
          : null,

      rsi14:
        Number.isFinite(rsi14)
          ? Number(rsi14.toFixed(2))
          : null,

      vwap:
        Number.isFinite(currentVwap)
          ? Number(currentVwap.toFixed(2))
          : null,

      relative_volume:
        Number.isFinite(relVol)
          ? Number(relVol.toFixed(2))
          : null,

      trend_15m: trend15,

      recent_high:
        Number.isFinite(recentHigh)
          ? Number(recentHigh.toFixed(2))
          : null,

      recent_low:
        Number.isFinite(recentLow)
          ? Number(recentLow.toFixed(2))
          : null,

      entry:
        entry !== null
          ? Number(entry.toFixed(2))
          : null,

      stop_loss:
        stopLoss !== null
          ? Number(stopLoss.toFixed(2))
          : null,

      target_1:
        target1 !== null
          ? Number(target1.toFixed(2))
          : null,

      target_2:
        target2 !== null
          ? Number(target2.toFixed(2))
          : null,

      capital: sizing.capital,
      quantity: sizing.quantity,
      risk: sizing.risk,
      target1_profit: sizing.target1_profit,
      target2_profit: sizing.target2_profit,
      risk_reward_1: sizing.risk_reward_1,
      risk_reward_2: sizing.risk_reward_2,

      price_gap_pct:
        Number.isFinite(quotePrice) &&
        Number.isFinite(chartPrice)
          ? Number(
              priceGapPercent(
                chartPrice,
                quotePrice
              ).toFixed(2)
            )
          : null,

      volume_confirmed: true
    };

  } catch (error) {
    console.error(
      `Error scanning ${symbol}:`,
      error?.message || error
    );

    return {
      symbol,
      signal: "UNAVAILABLE",
      reason:
        "NSE data retrieval failed",
      price: null,
      quote_price: null,
      ema20: null,
      rsi14: null,
      vwap: null,
      relative_volume: null,
      trend_15m: "UNKNOWN",
      recent_high: null,
      recent_low: null,
      entry: null,
      stop_loss: null,
      target_1: null,
      target_2: null,
      capital: null,
      quantity: 0,
      risk: null,
      target1_profit: null,
      target2_profit: null,
      risk_reward_1: null,
      risk_reward_2: null,
      volume_confirmed: false
    };
  }
}

async function main() {
  console.log(
    "Starting ₹1,000 Intraday Scanner..."
  );

  const results = [];

  // Sequential requests reduce the chance of
  // NSE/package rate limiting.
  for (const symbol of SYMBOLS) {
    console.log(`Scanning ${symbol}...`);

    const result =
      await scanStock(symbol);

    results.push(result);
  }

  const output = {
    updated_at:
      new Date().toISOString(),

    timezone:
      "Asia/Kolkata",

    market:
      "NSE",

    provider:
      "NSE chart data via stock-nse-india",

    interval:
      "5m + 15m confirmation",

    capital:
      CAPITAL,

    session:
      "09:15-15:15 IST",

    stocks:
      results
  };

  fs.writeFileSync(
    "data/intraday.json",
    JSON.stringify(
      output,
      null,
      2
    )
  );

  console.log(
    "Intraday scanner data written to data/intraday.json"
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
