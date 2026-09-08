const fs = require("fs");
const path = require("path");
const NSE = require("stock-nse-india");

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

const OUTPUT = path.join(__dirname, "..", "data", "intraday.json");

const MIN_5M_CANDLES = 25;
const MIN_15M_CANDLES = 20;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*
 * Get today's date in India.
 */
function getIndiaDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

/*
 * Convert India local time to UTC.

 * NSE:
 * 09:15 IST = 03:45 UTC
 * 15:15 IST = 09:45 UTC
 */
function indiaTimeToUTC(year, month, day, hour, minute) {
  return new Date(
    Date.UTC(year, month - 1, day, hour - 5, minute - 30, 0)
  );
}

/*
 * Request a BROAD range.

 * We intentionally request more data than today's session.
 * The returned candles are then filtered to today's NSE session.
 *
 * This prevents the scanner from accidentally receiving too few
 * candles because of the library/NSE chart endpoint's range handling.
 */
function broadChartRange() {
  const india = getIndiaDateParts();

  const start = new Date(
    Date.UTC(
      india.year,
      india.month - 1,
      india.day - 1,
      0,
      0,
      0
    )
  );

  const end = new Date(
    Date.UTC(
      india.year,
      india.month - 1,
      india.day,
      23,
      59,
      59
    )
  );

  return { start, end };
}

/*
 * Today's NSE signal session.
 */
function todaySessionRange() {
  const india = getIndiaDateParts();

  return {
    start: indiaTimeToUTC(
      india.year,
      india.month,
      india.day,
      9,
      15
    ),
    end: indiaTimeToUTC(
      india.year,
      india.month,
      india.day,
      15,
      15
    )
  };
}

/*
 * Convert timestamps safely.

 * Supports:
 * - Unix seconds
 * - Unix milliseconds
 * - Date strings
 */
function normalizeTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    // Unix seconds
    if (value < 100000000000) {
      return value * 1000;
    }

    // Unix milliseconds
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      if (numeric < 100000000000) {
        return numeric * 1000;
      }

      return numeric;
    }

    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/*
 * Convert chart candles into a consistent structure:
 *
 * {
 *   timestamp,
 *   open,
 *   high,
 *   low,
 *   close,
 *   volume
 * }
 */
function normalizeCandles(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const result = [];

  for (const candle of raw) {
    let timestamp;
    let open;
    let high;
    let low;
    let close;
    let volume;

    if (Array.isArray(candle)) {
      timestamp = candle[0];
      open = candle[1];
      high = candle[2];
      low = candle[3];
      close = candle[4];
      volume = candle[5];
    } else if (candle && typeof candle === "object") {
      timestamp =
        candle.timestamp ??
        candle.time ??
        candle.t ??
        candle.date;

      open =
        candle.open ??
        candle.o;

      high =
        candle.high ??
        candle.h;

      low =
        candle.low ??
        candle.l;

      close =
        candle.close ??
        candle.c;

      volume =
        candle.volume ??
        candle.v;
    }

    const ts = normalizeTimestamp(timestamp);

    const values = [
      Number(open),
      Number(high),
      Number(low),
      Number(close)
    ];

    if (
      !Number.isFinite(ts) ||
      values.some(v => !Number.isFinite(v))
    ) {
      continue;
    }

    const candleVolume = Number(volume);

    result.push({
      timestamp: ts,
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
      volume: Number.isFinite(candleVolume)
        ? candleVolume
        : null
    });
  }

  result.sort((a, b) => a.timestamp - b.timestamp);

  return result;
}

/*
 * Filter candles to today's NSE regular session.
 */
function filterSession(candles) {
  const session = todaySessionRange();

  return candles.filter(candle => {
    return (
      candle.timestamp >= session.start.getTime() &&
      candle.timestamp <= session.end.getTime()
    );
  });
}

/*
 * Detect and convert cumulative volume.

 * Some chart endpoints provide cumulative session volume.
 * Others provide individual candle volume.

 * If the values are mostly increasing, treat them as cumulative
 * and convert them into candle-by-candle volume.
 */
function normalizeVolume(candles) {
  const valid = candles
    .map(c => c.volume)
    .filter(v => Number.isFinite(v) && v >= 0);

  if (valid.length < 5) {
    return candles.map(c => ({
      ...c,
      volume: null
    }));
  }

  let increases = 0;
  let comparisons = 0;

  for (let i = 1; i < valid.length; i++) {
    if (valid[i] >= valid[i - 1]) {
      increases++;
    }

    comparisons++;
  }

  const cumulative =
    comparisons >= 4 &&
    increases / comparisons >= 0.8;

  if (!cumulative) {
    return candles;
  }

  let previous = null;

  return candles.map(candle => {
    if (!Number.isFinite(candle.volume)) {
      return {
        ...candle,
        volume: null
      };
    }

    if (previous === null) {
      previous = candle.volume;

      return {
        ...candle,
        volume: null
      };
    }

    const difference = candle.volume - previous;

    previous = candle.volume;

    return {
      ...candle,
      volume:
        Number.isFinite(difference) && difference >= 0
          ? difference
          : null
    };
  });
}

/*
 * Extract the chart response's candle array.
 */
function extractChartData(response) {
  if (!response) {
    return [];
  }

  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (response.data && Array.isArray(response.data.data)) {
    return response.data.data;
  }

  if (Array.isArray(response.chartData)) {
    return response.chartData;
  }

  if (response.data && Array.isArray(response.data.chartData)) {
    return response.data.chartData;
  }

  return [];
}

/*
 * Get EMA.
 */
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let value = 0;

  for (let i = 0; i < period; i++) {
    value += values[i];
  }

  value /= period;

  for (let i = period; i < values.length; i++) {
    value =
      (values[i] - value) * multiplier + value;
  }

  return value;
}

/*
 * RSI14.
 */
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) {
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

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

/*
 * Session VWAP.
 */
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
      (candle.high + candle.low + candle.close) / 3;

    cumulativePV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }

  if (cumulativeVolume <= 0) {
    return null;
  }

  return cumulativePV / cumulativeVolume;
}

/*
 * Relative volume.

 * Latest candle volume /
 * average of previous 20 valid candle volumes.
 */
function relativeVolume(candles) {
  const valid = candles.filter(
    c => Number.isFinite(c.volume) && c.volume > 0
  );

  if (valid.length < 21) {
    return null;
  }

  const latest = valid[valid.length - 1];

  const previous = valid.slice(-21, -1);

  const average =
    previous.reduce(
      (sum, candle) => sum + candle.volume,
      0
    ) / previous.length;

  if (!Number.isFinite(average) || average <= 0) {
    return null;
  }

  const value = latest.volume / average;

  if (!Number.isFinite(value)) {
    return null;
  }

  // Extremely large values are treated as unreliable.
  if (value > 20) {
    return null;
  }

  return value;
}

/*
 * Extract actual quote/LTP from NSE details.
 */
function extractLTP(details) {
  if (!details || typeof details !== "object") {
    return null;
  }

  const candidates = [
    details.priceInfo?.lastPrice,
    details.priceInfo?.lastTradedPrice,
    details.priceInfo?.ltp,
    details.priceInfo?.lastTradedPriceValue,

    details.lastPrice,
    details.lastTradedPrice,
    details.ltp
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

/*
 * Chart price vs actual LTP validation.

 * We allow up to 3% difference.
 * Anything larger is considered stale/wrong.
 */
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

/*
 * Check whether a price is reasonable.
 */
function validPrice(price) {
  return (
    Number.isFinite(price) &&
    price > 0 &&
    price < 1000000
  );
}

/*
 * Get chart data.

 * We request a broader range rather than only today's session.
 */
async function getChart(symbol, interval) {
  const range = broadChartRange();

  try {
    const response =
      await NSE.getEquityChartHistoricalData(
        symbol,
        range,
        undefined,
        "EQ",
        "index",
        String(interval)
      );

    return normalizeCandles(
      extractChartData(response)
    );
  } catch (error) {
    console.error(
      `[${symbol}] ${interval}m chart error:`,
      error?.message || error
    );

    return [];
  }
}

/*
 * Get quote/details.
 */
async function getQuote(symbol) {
  try {
    const details =
      await NSE.getEquityDetails(symbol);

    return {
      details,
      ltp: extractLTP(details)
    };
  } catch (error) {
    console.error(
      `[${symbol}] quote error:`,
      error?.message || error
    );

    return {
      details: null,
      ltp: null
    };
  }
}

/*
 * Scan one stock.
 */
async function scanStock(symbol) {
  console.log(`Scanning ${symbol}...`);

  try {
    const [
      chart5mRaw,
      chart15mRaw,
      quote
    ] = await Promise.all([
      getChart(symbol, 5),
      getChart(symbol, 15),
      getQuote(symbol)
    ]);

    let candles5m = filterSession(chart5mRaw);
    let candles15m = filterSession(chart15mRaw);

    candles5m = normalizeVolume(candles5m);

    if (candles5m.length < MIN_5M_CANDLES) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason:
          `Not enough 5m candles (${candles5m.length}/${MIN_5M_CANDLES})`,
        price: null,
        quote_price: quote.ltp,
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
        volume_confirmed: false
      };
    }

    if (candles15m.length < MIN_15M_CANDLES) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason:
          `Not enough 15m candles (${candles15m.length}/${MIN_15M_CANDLES})`,
        price: null,
        quote_price: quote.ltp,
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
        volume_confirmed: false
      };
    }

    const closes5m =
      candles5m.map(c => c.close);

    const closes15m =
      candles15m.map(c => c.close);

    const chartPrice =
      closes5m[closes5m.length - 1];

    const quotePrice = quote.ltp;

    /*
     * We strongly prefer the actual quote price.
     */
    const price =
      validPrice(quotePrice)
        ? quotePrice
        : chartPrice;

    if (!validPrice(price)) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason: "Invalid price data",
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
        volume_confirmed: false
      };
    }

    /*
     * If both chart and quote prices exist, cross-check them.
     */
    const gap = priceGapPercent(
      chartPrice,
      quotePrice
    );

    if (
      gap !== null &&
      gap > 3
    ) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason:
          `Chart/LTP mismatch (${gap.toFixed(2)}%)`,
        price: quotePrice,
        quote_price: quotePrice,
        chart_price: chartPrice,
        price_gap_pct: gap,
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
        volume_confirmed: false
      };
    }

    const ema20 =
      ema(closes5m, 20);

    const rsi14 =
      rsi(closes5m, 14);

    const sessionVWAP =
      vwap(candles5m);

    const relVolume =
      relativeVolume(candles5m);

    const ema15 =
      ema(closes15m, 20);

    const latest15m =
      closes15m[closes15m.length - 1];

    let trend15m = "UNKNOWN";

    if (
      Number.isFinite(ema15) &&
      Number.isFinite(latest15m)
    ) {
      if (latest15m > ema15) {
        trend15m = "BULLISH";
      } else if (latest15m < ema15) {
        trend15m = "BEARISH";
      } else {
        trend15m = "NEUTRAL";
      }
    }

    const recentCandles =
      candles5m.slice(-12);

    const recentHigh =
      Math.max(
        ...recentCandles.map(c => c.high)
      );

    const recentLow =
      Math.min(
        ...recentCandles.map(c => c.low)
      );

    const nearHigh =
      price >= recentHigh * 0.997;

    const nearLow =
      price <= recentLow * 1.003;

    /*
     * Volume must be available before BUY/SELL.
     */
    if (!Number.isFinite(relVolume)) {
      return {
        symbol,
        signal: "WATCH",
        reason:
          "Volume confirmation unavailable",
        price,
        quote_price: quotePrice,
        chart_price: chartPrice,
        price_gap_pct: gap,
        ema20,
        rsi14,
        vwap: sessionVWAP,
        relative_volume: null,
        trend_15m: trend15m,
        recent_high: recentHigh,
        recent_low: recentLow,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        volume_confirmed: false
      };
    }

    let signal = "WATCH";
    let reason = "Mixed conditions";

    /*
     * BUY conditions:
     *
     * Price > EMA20
     * Price > VWAP
     * RSI 52-70
     * Relative volume >= 1.2x
     * Near recent high
     * 15m bullish
     */
    const buy =
      Number.isFinite(ema20) &&
      Number.isFinite(rsi14) &&
      Number.isFinite(sessionVWAP) &&
      price > ema20 &&
      price > sessionVWAP &&
      rsi14 >= 52 &&
      rsi14 <= 70 &&
      relVolume >= 1.2 &&
      nearHigh &&
      trend15m === "BULLISH";

    /*
     * SELL conditions.
     */
    const sell =
      Number.isFinite(ema20) &&
      Number.isFinite(rsi14) &&
      Number.isFinite(sessionVWAP) &&
      price < ema20 &&
      price < sessionVWAP &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      relVolume >= 1.2 &&
      nearLow &&
      trend15m === "BEARISH";

    if (buy) {
      signal = "BUY";
      reason =
        "5m bullish + VWAP/EMA20 confirmation + RSI + volume + 15m bullish";
    } else if (sell) {
      signal = "SELL";
      reason =
        "5m bearish + VWAP/EMA20 confirmation + RSI + volume + 15m bearish";
    }

    /*
     * Risk levels only for actionable signals.
     */
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

    return {
      symbol,
      signal,
      reason,
      price,
      quote_price: quotePrice,
      chart_price: chartPrice,
      price_gap_pct: gap,
      ema20,
      rsi14,
      vwap: sessionVWAP,
      relative_volume: relVolume,
      trend_15m: trend15m,
      recent_high: recentHigh,
      recent_low: recentLow,
      entry,
      stop_loss: stopLoss,
      target_1: target1,
      target_2: target2,
      volume_confirmed: true
    };

  } catch (error) {
    console.error(
      `[${symbol}] scan failed:`,
      error?.stack || error
    );

    return {
      symbol,
      signal: "UNAVAILABLE",
      reason:
        error?.message ||
        "Scanner error",
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
      volume_confirmed: false
    };
  }
}

/*
 * Main.
 */
async function main() {
  console.log(
    "Starting token-free NSE intraday scanner..."
  );

  console.log(
    "Signal session: 09:15-15:15 IST"
  );

  const results = [];

  for (const symbol of SYMBOLS) {
    const result = await scanStock(symbol);

    results.push(result);

    /*
     * Small delay to reduce pressure on NSE.
     */
    await sleep(300);
  }

  const india = getIndiaDateParts();

  const output = {
    updated_at: new Date().toISOString(),
    timezone: "Asia/Kolkata",
    market: "NSE",
    provider:
      "NSE chart data via stock-nse-india",
    interval:
      "5m + 15m confirmation",
    signal_session:
      "09:15-15:15 IST",

    methodology: {
      ema:
        "EMA20 on 5m candles",
      rsi:
        "RSI14 on 5m candles",
      vwap:
        "Session VWAP on 5m candles",
      relative_volume:
        "Latest valid 5m volume divided by average previous 20 valid 5m volumes",
      trend_confirmation:
        "15m close compared with 15m EMA20",
      buy:
        "Price > EMA20 and VWAP + RSI 52-70 + relative volume >= 1.2x + near recent high + 15m bullish",
      sell:
        "Price < EMA20 and VWAP + RSI 30-48 + relative volume >= 1.2x + near recent low + 15m bearish",
      risk:
        "Stop 0.4%, Target 1 0.4%, Target 2 0.8%"
    },

    data_quality:
      "Broad chart retrieval, IST session filtering, actual-LTP extraction, chart/LTP cross-check, epoch timestamp handling and volume validation enabled.",

    stocks: results
  };

  /*
   * Atomic write.
   */
  const tempFile = `${OUTPUT}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  fs.renameSync(
    tempFile,
    OUTPUT
  );

  const counts = {
    BUY: results.filter(r => r.signal === "BUY").length,
    SELL: results.filter(r => r.signal === "SELL").length,
    WATCH: results.filter(r => r.signal === "WATCH").length,
    UNAVAILABLE:
      results.filter(
        r => r.signal === "UNAVAILABLE"
      ).length
  };

  console.log("");
  console.log("Scanner complete.");
  console.log(
    `BUY: ${counts.BUY}`
  );
  console.log(
    `SELL: ${counts.SELL}`
  );
  console.log(
    `WATCH: ${counts.WATCH}`
  );
  console.log(
    `UNAVAILABLE: ${counts.UNAVAILABLE}`
  );
  console.log(
    `Output: ${OUTPUT}`
  );
}

main().catch(error => {
  console.error(
    "Fatal scanner error:",
    error?.stack || error
  );

  process.exit(1);
});
