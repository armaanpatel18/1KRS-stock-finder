const fs = require("fs");
const path = require("path");
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

const OUTPUT = path.join(
  __dirname,
  "..",
  "data",
  "intraday.json"
);

const MIN_5M_CANDLES = 25;
const MIN_15M_CANDLES = 20;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

/* -------------------------------------------------------
   INDIA DATE / SESSION
------------------------------------------------------- */

function indiaDateParts() {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(new Date());

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

/*
 * Convert IST clock time to UTC Date.
 */
function istToUTC(
  year,
  month,
  day,
  hour,
  minute
) {
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour - 5,
      minute - 30,
      0
    )
  );
}

/*
 * NSE regular signal session:
 * 09:15 IST -> 15:15 IST
 */
function sessionRange() {
  const d = indiaDateParts();

  return {
    start: istToUTC(
      d.year,
      d.month,
      d.day,
      9,
      15
    ),
    end: istToUTC(
      d.year,
      d.month,
      d.day,
      15,
      15
    )
  };
}

/*
 * Request a wider range than the session.

 * This avoids accidentally receiving zero candles
 * because of timezone/date-boundary issues.
 */
function chartRange() {
  const d = indiaDateParts();

  const start = new Date(
    Date.UTC(
      d.year,
      d.month - 1,
      d.day - 2,
      0,
      0,
      0
    )
  );

  const end = new Date(
    Date.UTC(
      d.year,
      d.month - 1,
      d.day,
      23,
      59,
      59
    )
  );

  return {
    start,
    end
  };
}

/* -------------------------------------------------------
   TIMESTAMP
------------------------------------------------------- */

function timestampMs(value) {
  if (
    value === null ||
    value === undefined
  ) {
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
      return numeric < 100000000000
        ? numeric * 1000
        : numeric;
    }

    const parsed = Date.parse(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

/* -------------------------------------------------------
   CANDLE NORMALIZATION
------------------------------------------------------- */

function normalizeCandles(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const candles = [];

  for (const item of raw) {
    let timestamp;
    let open;
    let high;
    let low;
    let close;
    let volume;

    /*
     * Array format:
     * [timestamp, open, high, low, close, volume]
     */
    if (Array.isArray(item)) {
      timestamp = item[0];
      open = item[1];
      high = item[2];
      low = item[3];
      close = item[4];
      volume = item[5];
    }

    /*
     * Object format:
     */
    else if (
      item &&
      typeof item === "object"
    ) {
      timestamp =
        item.timestamp ??
        item.time ??
        item.t ??
        item.date;

      open =
        item.open ??
        item.o;

      high =
        item.high ??
        item.h;

      low =
        item.low ??
        item.l;

      close =
        item.close ??
        item.c;

      volume =
        item.volume ??
        item.v;
    }

    const ts = timestampMs(timestamp);

    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    const v = Number(volume);

    if (
      !Number.isFinite(ts) ||
      !Number.isFinite(o) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(c)
    ) {
      continue;
    }

    candles.push({
      timestamp: ts,
      open: o,
      high: h,
      low: l,
      close: c,
      volume:
        Number.isFinite(v) && v >= 0
          ? v
          : null
    });
  }

  candles.sort(
    (a, b) =>
      a.timestamp - b.timestamp
  );

  return candles;
}

/*
 * Extract data from different possible response structures.
 */
function extractArray(response) {
  if (!response) {
    return [];
  }

  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (
    response.data &&
    Array.isArray(response.data.data)
  ) {
    return response.data.data;
  }

  if (
    response.data &&
    Array.isArray(response.data.chartData)
  ) {
    return response.data.chartData;
  }

  if (Array.isArray(response.chartData)) {
    return response.chartData;
  }

  if (Array.isArray(response.records)) {
    return response.records;
  }

  return [];
}

/* -------------------------------------------------------
   SESSION FILTER
------------------------------------------------------- */

function filterSession(candles) {
  const session = sessionRange();

  return candles.filter(candle =>
    candle.timestamp >=
      session.start.getTime() &&
    candle.timestamp <=
      session.end.getTime()
  );
}

/* -------------------------------------------------------
   VOLUME
------------------------------------------------------- */

function normalizeVolume(candles) {
  const valid = candles
    .map(c => c.volume)
    .filter(
      v =>
        Number.isFinite(v) &&
        v >= 0
    );

  if (valid.length < 5) {
    return candles.map(c => ({
      ...c,
      volume: null
    }));
  }

  let increases = 0;
  let comparisons = 0;

  for (
    let i = 1;
    i < valid.length;
    i++
  ) {
    comparisons++;

    if (valid[i] >= valid[i - 1]) {
      increases++;
    }
  }

  /*
   * If volume is almost always increasing,
   * it is probably cumulative session volume.
   */
  const isCumulative =
    comparisons >= 4 &&
    increases / comparisons >= 0.8;

  if (!isCumulative) {
    return candles;
  }

  let previous = null;

  return candles.map(candle => {
    if (
      !Number.isFinite(candle.volume)
    ) {
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

    const difference =
      candle.volume - previous;

    previous = candle.volume;

    return {
      ...candle,
      volume:
        difference >= 0
          ? difference
          : null
    };
  });
}

/* -------------------------------------------------------
   INDICATORS
------------------------------------------------------- */

function ema(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    result += values[i];
  }

  result /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (values[i] - result) *
        multiplier +
      result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (
    !Array.isArray(values) ||
    values.length < period + 1
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    avgGain =
      (
        avgGain * (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function calculateVWAP(candles) {
  let pv = 0;
  let volume = 0;

  for (const candle of candles) {
    if (
      !Number.isFinite(
        candle.volume
      ) ||
      candle.volume <= 0
    ) {
      continue;
    }

    const typical =
      (
        candle.high +
        candle.low +
        candle.close
      ) / 3;

    pv +=
      typical *
      candle.volume;

    volume +=
      candle.volume;
  }

  if (volume <= 0) {
    return null;
  }

  return pv / volume;
}

function calculateRelativeVolume(
  candles
) {
  const valid =
    candles.filter(
      c =>
        Number.isFinite(
          c.volume
        ) &&
        c.volume > 0
    );

  if (valid.length < 21) {
    return null;
  }

  const latest =
    valid[valid.length - 1];

  const previous =
    valid.slice(-21, -1);

  const average =
    previous.reduce(
      (sum, c) =>
        sum + c.volume,
      0
    ) / previous.length;

  if (
    !Number.isFinite(
      average
    ) ||
    average <= 0
  ) {
    return null;
  }

  const result =
    latest.volume /
    average;

  /*
   * Ignore clearly broken volume values.
   */
  if (
    !Number.isFinite(result) ||
    result > 20
  ) {
    return null;
  }

  return result;
}

/* -------------------------------------------------------
   PRICE / QUOTE
------------------------------------------------------- */

function extractLTP(details) {
  if (
    !details ||
    typeof details !== "object"
  ) {
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

function priceGap(
  chartPrice,
  quotePrice
) {
  if (
    !Number.isFinite(
      chartPrice
    ) ||
    !Number.isFinite(
      quotePrice
    ) ||
    quotePrice <= 0
  ) {
    return null;
  }

  return (
    Math.abs(
      chartPrice -
        quotePrice
    ) /
    quotePrice
  ) * 100;
}

/* -------------------------------------------------------
   CHART DATA
------------------------------------------------------- */

/*
 * This is the important correction.

 * v1.4.0 explicitly supports:
 *
 * symbol
 * range
 * token
 * symbolType = Equity
 * chartType = I
 * timeInterval = 5 / 15
 */
async function getChart(
  symbol,
  interval
) {
  const range =
    chartRange();

  try {
    const response =
      await nse.getEquityChartHistoricalData(
        symbol,
        range,
        undefined,
        "Equity",
        "I",
        String(interval)
      );

    const raw =
      extractArray(response);

    const candles =
      normalizeCandles(raw);

    console.log(
      `[${symbol}] ${interval}m raw candles: ${candles.length}`
    );

    return candles;
  } catch (error) {
    console.error(
      `[${symbol}] ${interval}m chart error:`,
      error?.message ||
        error
    );

    return [];
  }
}

/* -------------------------------------------------------
   QUOTE
------------------------------------------------------- */

async function getQuote(symbol) {
  try {
    const details =
      await nse.getEquityDetails(
        symbol
      );

    return {
      details,
      ltp:
        extractLTP(details)
    };
  } catch (error) {
    console.error(
      `[${symbol}] quote error:`,
      error?.message ||
        error
    );

    return {
      details: null,
      ltp: null
    };
  }
}

/* -------------------------------------------------------
   SCAN
------------------------------------------------------- */

async function scanStock(symbol) {
  console.log(
    `\nScanning ${symbol}...`
  );

  try {
    const [
      raw5m,
      raw15m,
      quote
    ] = await Promise.all([
      getChart(symbol, 5),
      getChart(symbol, 15),
      getQuote(symbol)
    ]);

    let candles5m =
      filterSession(raw5m);

    let candles15m =
      filterSession(raw15m);

    candles5m =
      normalizeVolume(
        candles5m
      );

    console.log(
      `[${symbol}] session candles: 5m=${candles5m.length}, 15m=${candles15m.length}`
    );

    /*
     * EARLY MARKET HANDLING.

     * Do not call this a data failure.
     */
    if (
      candles5m.length <
      MIN_5M_CANDLES
    ) {
      return {
        symbol,
        signal: "WAIT",
        reason:
          `Building 5m intraday history (${candles5m.length}/${MIN_5M_CANDLES} candles)`,
        price: quote.ltp,
        quote_price: quote.ltp,
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
        volume_confirmed: false
      };
    }

    /*
     * 15m needs enough candles for EMA20.

     * If 15m history is still building,
     * don't generate BUY/SELL.
     */
    if (
      candles15m.length <
      MIN_15M_CANDLES
    ) {
      return {
        symbol,
        signal: "WAIT",
        reason:
          `Building 15m confirmation history (${candles15m.length}/${MIN_15M_CANDLES} candles)`,
        price: quote.ltp,
        quote_price: quote.ltp,
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
        volume_confirmed: false
      };
    }

    const closes5m =
      candles5m.map(
        c => c.close
      );

    const closes15m =
      candles15m.map(
        c => c.close
      );

    const chartPrice =
      closes5m[
        closes5m.length - 1
      ];

    const quotePrice =
      quote.ltp;

    const price =
      Number.isFinite(
        quotePrice
      ) &&
      quotePrice > 0
        ? quotePrice
        : chartPrice;

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason:
          "No valid current price",
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
     * Cross-check chart price and quote.
     */
    const gap =
      priceGap(
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
      ema(
        closes5m,
        20
      );

    const rsi14 =
      rsi(
        closes5m,
        14
      );

    const vwap =
      calculateVWAP(
        candles5m
      );

    const relativeVolume =
      calculateRelativeVolume(
        candles5m
      );

    const ema15 =
      ema(
        closes15m,
        20
      );

    const latest15m =
      closes15m[
        closes15m.length - 1
      ];

    let trend15m =
      "UNKNOWN";

    if (
      Number.isFinite(
        ema15
      )
    ) {
      if (
        latest15m >
        ema15
      ) {
        trend15m =
          "BULLISH";
      } else if (
        latest15m <
        ema15
      ) {
        trend15m =
          "BEARISH";
      } else {
        trend15m =
          "NEUTRAL";
      }
    }

    const recent =
      candles5m.slice(-12);

    const recentHigh =
      Math.max(
        ...recent.map(
          c => c.high
        )
      );

    const recentLow =
      Math.min(
        ...recent.map(
          c => c.low
        )
      );

    const nearHigh =
      price >=
      recentHigh * 0.997;

    const nearLow =
      price <=
      recentLow * 1.003;

    /*
     * Without volume confirmation,
     * BUY/SELL is forbidden.
     */
    if (
      !Number.isFinite(
        relativeVolume
      )
    ) {
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
        vwap,
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

    /*
     * BUY.
     */
    const buy =
      Number.isFinite(
        ema20
      ) &&
      Number.isFinite(
        rsi14
      ) &&
      Number.isFinite(
        vwap
      ) &&
      price > ema20 &&
      price > vwap &&
      rsi14 >= 52 &&
      rsi14 <= 70 &&
      relativeVolume >= 1.2 &&
      nearHigh &&
      trend15m ===
        "BULLISH";

    /*
     * SELL.
     */
    const sell =
      Number.isFinite(
        ema20
      ) &&
      Number.isFinite(
        rsi14
      ) &&
      Number.isFinite(
        vwap
      ) &&
      price < ema20 &&
      price < vwap &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      relativeVolume >= 1.2 &&
      nearLow &&
      trend15m ===
        "BEARISH";

    let signal =
      "WATCH";

    let reason =
      "Mixed conditions";

    let entry = null;
    let stopLoss = null;
    let target1 = null;
    let target2 = null;

    if (buy) {
      signal = "BUY";

      reason =
        "5m bullish + VWAP + EMA20 + RSI + volume + 15m bullish";

      entry = price;

      stopLoss =
        price * 0.996;

      target1 =
        price * 1.004;

      target2 =
        price * 1.008;
    }

    if (sell) {
      signal = "SELL";

      reason =
        "5m bearish + VWAP + EMA20 + RSI + volume + 15m bearish";

      entry = price;

      stopLoss =
        price * 1.004;

      target1 =
        price * 0.996;

      target2 =
        price * 0.992;
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
      vwap,
      relative_volume:
        relativeVolume,
      trend_15m:
        trend15m,
      recent_high:
        recentHigh,
      recent_low:
        recentLow,
      entry,
      stop_loss:
        stopLoss,
      target_1:
        target1,
      target_2:
        target2,
      volume_confirmed:
        true
    };

  } catch (error) {
    console.error(
      `[${symbol}] scan failed:`,
      error?.stack ||
        error
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

/* -------------------------------------------------------
   MAIN
------------------------------------------------------- */

async function main() {
  console.log(
    "======================================"
  );

  console.log(
    "NSE TOKEN-FREE INTRADAY SCANNER"
  );

  console.log(
    "======================================"
  );

  console.log(
    "Session: 09:15-15:15 IST"
  );

  console.log(
    "Intervals: 5m + 15m"
  );

  console.log(
    "Symbols:",
    SYMBOLS.length
  );

  const results = [];

  for (const symbol of SYMBOLS) {
    const result =
      await scanStock(symbol);

    results.push(result);

    /*
     * Avoid hammering NSE.
     */
    await sleep(500);
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
      "Intraday chart type, IST session filtering, LTP cross-check, timestamp normalization and volume validation enabled.",

    stocks:
      results
  };

  /*
   * Atomic write.
   */
  const temp =
    `${OUTPUT}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      output,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temp,
    OUTPUT
  );

  const summary = {
    BUY:
      results.filter(
        r => r.signal === "BUY"
      ).length,

    SELL:
      results.filter(
        r => r.signal === "SELL"
      ).length,

    WATCH:
      results.filter(
        r => r.signal === "WATCH"
      ).length,

    WAIT:
      results.filter(
        r => r.signal === "WAIT"
      ).length,

    UNAVAILABLE:
      results.filter(
        r =>
          r.signal ===
          "UNAVAILABLE"
      ).length
  };

  console.log("");
  console.log(
    "Scanner finished."
  );

  console.log(
    JSON.stringify(
      summary,
      null,
      2
    )
  );

  console.log(
    `Output: ${OUTPUT}`
  );
}

main().catch(error => {
  console.error(
    "Fatal scanner error:",
    error?.stack ||
      error
  );

  process.exit(1);
});
