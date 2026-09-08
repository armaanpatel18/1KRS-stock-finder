const fs = require("fs");
const path = require("path");
const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

const UNIVERSE_FILE = path.join(__dirname, "..", "data", "universe.json");
const OUTPUT_FILE = path.join(__dirname, "..", "data", "intraday.json");

const MIN_5M_CANDLES = 25;
const MIN_15M_CANDLES = 20;

const SIGNAL_START = "09:15";
const SIGNAL_END = "15:15";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------
   INDIA DATE / TIME HELPERS
--------------------------------------------------------- */

function indiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

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

function pad(n) {
  return String(n).padStart(2, "0");
}

function isoDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/*
  GitHub Actions runs in UTC.

  NSE session:
  09:15 IST = 03:45 UTC
  15:15 IST = 09:45 UTC
*/

function indiaSessionRange() {
  const now = new Date();

  const { year, month, day } = indiaDateParts(now);

  const date = isoDate(year, month, day);

  const start = new Date(`${date}T03:45:00.000Z`);
  const end = new Date(`${date}T09:45:00.000Z`);

  return {
    date,
    start,
    end
  };
}

/*
  Request a little historical range so indicators can warm up.
*/
function chartRequestRange() {
  const { year, month, day } = indiaDateParts();

  const today = new Date(Date.UTC(year, month - 1, day));

  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 3);

  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

/* ---------------------------------------------------------
   NUMBER / TIMESTAMP HELPERS
--------------------------------------------------------- */

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampMs(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  /*
    NSE timestamps may be:
      seconds
      milliseconds
  */
  if (n < 1e12) {
    return n * 1000;
  }

  return n;
}

/* ---------------------------------------------------------
   NORMALIZE CHART DATA
--------------------------------------------------------- */

/*
  Expected chart OHLCV structure:

  {
    open,
    high,
    low,
    close,
    volume,
    time
  }

  Some package versions may return arrays:

  [timestamp, open, high, low, close, volume]
*/

function normalizeChartData(response) {
  let raw = [];

  if (Array.isArray(response)) {
    raw = response;
  } else if (Array.isArray(response?.data)) {
    raw = response.data;
  } else if (Array.isArray(response?.grapthData)) {
    /*
      grapthData is only:
      [timestamp, price, "NM"]

      It is NOT suitable for OHLCV indicators.
    */
    return [];
  }

  const candles = [];

  for (const item of raw) {
    let candle = null;

    if (Array.isArray(item)) {
      /*
        [timestamp, open, high, low, close, volume]
      */

      const t = timestampMs(item[0]);

      candle = {
        timestamp: t,
        open: number(item[1]),
        high: number(item[2]),
        low: number(item[3]),
        close: number(item[4]),
        volume: number(item[5])
      };
    } else if (item && typeof item === "object") {
      const t = timestampMs(
        item.time ??
        item.timestamp ??
        item.ts ??
        item.t
      );

      candle = {
        timestamp: t,
        open: number(item.open ?? item.o),
        high: number(item.high ?? item.h),
        low: number(item.low ?? item.l),
        close: number(item.close ?? item.c),
        volume: number(item.volume ?? item.v)
      };
    }

    if (
      candle &&
      candle.timestamp &&
      candle.open !== null &&
      candle.high !== null &&
      candle.low !== null &&
      candle.close !== null
    ) {
      candles.push(candle);
    }
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);

  return candles;
}

/* ---------------------------------------------------------
   FILTER INDIA SESSION
--------------------------------------------------------- */

function filterSession(candles, start, end) {
  return candles.filter(c =>
    c.timestamp >= start.getTime() &&
    c.timestamp <= end.getTime()
  );
}

/* ---------------------------------------------------------
   VOLUME NORMALIZATION
--------------------------------------------------------- */

/*
  NSE data can sometimes expose cumulative volume.

  Convert cumulative volume:

      1000
      1500
      2200

  into candle volume:

      1000
      500
      700

  If volume is already per-candle, preserve it.
*/

function normalizeVolume(candles) {
  const volumes = candles.map(c => c.volume);

  const valid = volumes.filter(v =>
    Number.isFinite(v) && v >= 0
  );

  if (valid.length < 3) {
    return candles;
  }

  let increasing = 0;
  let comparisons = 0;

  for (let i = 1; i < valid.length; i++) {
    if (valid[i] >= valid[i - 1]) {
      increasing++;
    }

    comparisons++;
  }

  const looksCumulative =
    comparisons >= 3 &&
    increasing / comparisons >= 0.85;

  if (!looksCumulative) {
    return candles;
  }

  let previous = null;

  return candles.map((c, index) => {
    const current = c.volume;

    if (!Number.isFinite(current)) {
      return {
        ...c,
        volume: null
      };
    }

    if (index === 0 || previous === null) {
      previous = current;

      return {
        ...c,
        volume: null
      };
    }

    const difference = current - previous;

    previous = current;

    return {
      ...c,
      volume: difference >= 0 ? difference : null
    };
  });
}

/* ---------------------------------------------------------
   TECHNICAL INDICATORS
--------------------------------------------------------- */

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result = 0;

  for (let i = 0; i < period; i++) {
    result += values[i];
  }

  result /= period;

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

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

function vwap(candles) {
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    if (
      !Number.isFinite(c.volume) ||
      c.volume <= 0
    ) {
      continue;
    }

    const typicalPrice =
      (c.high + c.low + c.close) / 3;

    cumulativePV +=
      typicalPrice * c.volume;

    cumulativeVolume += c.volume;
  }

  if (cumulativeVolume <= 0) {
    return null;
  }

  return cumulativePV / cumulativeVolume;
}

function average(values) {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce((sum, value) => sum + value, 0) /
    valid.length
  );
}

/* ---------------------------------------------------------
   RELATIVE VOLUME
--------------------------------------------------------- */

function relativeVolume(candles) {
  if (candles.length < 21) {
    return null;
  }

  const latest = candles[candles.length - 1];

  if (
    !Number.isFinite(latest.volume) ||
    latest.volume <= 0
  ) {
    return null;
  }

  const previous20 = candles
    .slice(-21, -1)
    .map(c => c.volume)
    .filter(v =>
      Number.isFinite(v) && v > 0
    );

  if (previous20.length < 10) {
    return null;
  }

  const avg = average(previous20);

  if (!avg || avg <= 0) {
    return null;
  }

  const result = latest.volume / avg;

  /*
    Extremely large values are usually bad data.
  */
  if (!Number.isFinite(result) || result > 20) {
    return null;
  }

  return result;
}

/* ---------------------------------------------------------
   15 MINUTE TREND
--------------------------------------------------------- */

function trend15m(candles) {
  if (candles.length < MIN_15M_CANDLES) {
    return "BUILDING";
  }

  const closes = candles.map(c => c.close);

  const latest = closes[closes.length - 1];

  const ema20 = ema(closes, 20);

  if (!Number.isFinite(ema20)) {
    return "BUILDING";
  }

  if (latest > ema20) {
    return "BULLISH";
  }

  if (latest < ema20) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

/* ---------------------------------------------------------
   PRICE VALIDATION
--------------------------------------------------------- */

function priceDifferencePercent(a, b) {
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b === 0
  ) {
    return null;
  }

  return Math.abs((a - b) / b) * 100;
}

/* ---------------------------------------------------------
   LIVE PRICE
--------------------------------------------------------- */

/*
  grapthData is our confirmed intraday price source.

  We deliberately use the LAST grapthData price rather than
  assuming priceInfo.lastPrice is always the LTP.
*/

async function getIntradayPrice(symbol) {
  try {
    const response =
      await nse.getEquityIntradayData(symbol);

    const data = response?.grapthData;

    if (!Array.isArray(data) || !data.length) {
      return {
        price: null,
        timestamp: null,
        points: 0
      };
    }

    const points = data
      .map(item => {
        if (!Array.isArray(item)) {
          return null;
        }

        const timestamp =
          timestampMs(item[0]);

        const price =
          number(item[1]);

        if (
          !timestamp ||
          !Number.isFinite(price)
        ) {
          return null;
        }

        return {
          timestamp,
          price
        };
      })
      .filter(Boolean)
      .sort((a, b) =>
        a.timestamp - b.timestamp
      );

    if (!points.length) {
      return {
        price: null,
        timestamp: null,
        points: 0
      };
    }

    const latest =
      points[points.length - 1];

    return {
      price: latest.price,
      timestamp: latest.timestamp,
      points: points.length
    };
  } catch (error) {
    console.error(
      `${symbol}: intraday price error:`,
      error.message
    );

    return {
      price: null,
      timestamp: null,
      points: 0
    };
  }
}

/* ---------------------------------------------------------
   CHART HISTORY
--------------------------------------------------------- */

async function getChart(symbol, interval) {
  const range = chartRequestRange();

  try {
    /*
      IMPORTANT:

      stock-nse-india v1.4.0 expects:

      symbolType = "Equity"
      chartType  = "I"
      interval   = "5" / "15"

      The previous scanner used incorrect values,
      which could result in zero candles.
    */

    const response =
      await nse.getEquityChartHistoricalData(
        symbol,
        range,
        undefined,
        "Equity",
        "I",
        String(interval)
      );

    return normalizeChartData(response);
  } catch (error) {
    console.error(
      `${symbol}: ${interval}m chart error:`,
      error.message
    );

    return [];
  }
}

/* ---------------------------------------------------------
   SCAN ONE STOCK
--------------------------------------------------------- */

async function scanStock(symbol) {
  console.log(`Scanning ${symbol}...`);

  try {
    /*
      Fetch all three streams in parallel.
    */
    const [
      chart5Raw,
      chart15Raw,
      intraday
    ] = await Promise.all([
      getChart(symbol, 5),
      getChart(symbol, 15),
      getIntradayPrice(symbol)
    ]);

    const {
      start,
      end,
      date
    } = indiaSessionRange();

    /*
      Keep only today's NSE session.
    */
    let candles5 =
      filterSession(
        chart5Raw,
        start,
        end
      );

    let candles15 =
      filterSession(
        chart15Raw,
        start,
        end
      );

    /*
      Convert cumulative volume if necessary.
    */
    candles5 =
      normalizeVolume(candles5);

    candles15 =
      normalizeVolume(candles15);

    const livePrice = intraday.price;

    /*
      No intraday price = no signal.
    */
    if (!Number.isFinite(livePrice)) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason: "No valid NSE intraday price",
        price: null,
        quote_price: null,
        ema20: null,
        rsi14: null,
        vwap: null,
        relative_volume: null,
        trend_15m: "UNAVAILABLE",
        recent_high: null,
        recent_low: null,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        volume_confirmed: false,
        intraday_points: intraday.points
      };
    }

    /*
      IMPORTANT:

      We no longer require 25 candles before returning
      the actual price.

      Early in the session, technical indicators remain
      BUILDING rather than incorrectly showing UNAVAILABLE.
    */

    if (candles5.length < MIN_5M_CANDLES) {
      return {
        symbol,
        signal: "WAIT",
        reason:
          `Building 5m intraday history (${candles5.length}/${MIN_5M_CANDLES} candles)`,
        price: livePrice,
        quote_price: livePrice,
        ema20: null,
        rsi14: null,
        vwap: null,
        relative_volume: null,
        trend_15m:
          candles15.length < MIN_15M_CANDLES
            ? "BUILDING"
            : trend15m(candles15),
        recent_high: null,
        recent_low: null,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        volume_confirmed: false,
        intraday_points: intraday.points
      };
    }

    /*
      Latest 5m candle.
    */
    const latest5 =
      candles5[candles5.length - 1];

    /*
      Compare latest chart close with the confirmed
      intraday price.

      3% is a hard safety limit.
    */
    const chartPrice =
      latest5.close;

    const priceGap =
      priceDifferencePercent(
        chartPrice,
        livePrice
      );

    if (
      priceGap === null ||
      priceGap > 3
    ) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason:
          `Chart/LTP mismatch (${priceGap?.toFixed(2) ?? "unknown"}%)`,
        price: livePrice,
        quote_price: livePrice,
        ema20: null,
        rsi14: null,
        vwap: null,
        relative_volume: null,
        trend_15m: "UNAVAILABLE",
        recent_high: null,
        recent_low: null,
        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        volume_confirmed: false,
        price_gap_pct: priceGap,
        intraday_points: intraday.points
      };
    }

    const closes =
      candles5.map(c => c.close);

    const ema20 =
      ema(closes, 20);

    const rsi14 =
      rsi(closes, 14);

    const currentVwap =
      vwap(candles5);

    const relVol =
      relativeVolume(candles5);

    const trend =
      trend15m(candles15);

    const recentCandles =
      candles5.slice(-20);

    const recentHigh =
      Math.max(
        ...recentCandles.map(c => c.high)
      );

    const recentLow =
      Math.min(
        ...recentCandles.map(c => c.low)
      );

    /*
      Price used for signals is the validated intraday
      price, not a stale chart close.
    */
    const price = livePrice;

    /*
      "Near recent high/low" means within 0.5%.
    */
    const nearHigh =
      price >= recentHigh * 0.995;

    const nearLow =
      price <= recentLow * 1.005;

    const volumeConfirmed =
      Number.isFinite(relVol) &&
      relVol >= 1.2;

    let signal = "WATCH";
    let reason = "Mixed conditions";

    /*
      BUY
    */
    if (
      Number.isFinite(ema20) &&
      Number.isFinite(rsi14) &&
      Number.isFinite(currentVwap) &&
      Number.isFinite(relVol) &&

      price > ema20 &&
      price > currentVwap &&

      rsi14 >= 52 &&
      rsi14 <= 70 &&

      relVol >= 1.2 &&

      nearHigh &&

      trend === "BULLISH"
    ) {
      signal = "BUY";
      reason =
        "5m bullish + VWAP/EMA support + RSI confirmation + volume + 15m bullish trend";
    }

    /*
      SELL
    */
    else if (
      Number.isFinite(ema20) &&
      Number.isFinite(rsi14) &&
      Number.isFinite(currentVwap) &&
      Number.isFinite(relVol) &&

      price < ema20 &&
      price < currentVwap &&

      rsi14 >= 30 &&
      rsi14 <= 48 &&

      relVol >= 1.2 &&

      nearLow &&

      trend === "BEARISH"
    ) {
      signal = "SELL";
      reason =
        "5m bearish + VWAP/EMA resistance + RSI confirmation + volume + 15m bearish trend";
    }

    /*
      If volume is unavailable, never generate BUY/SELL.
    */
    else if (!Number.isFinite(relVol)) {
      signal = "WATCH";
      reason =
        "Volume confirmation unavailable";
    }

    /*
      If 15m history isn't ready, no directional signal.
    */
    else if (trend === "BUILDING") {
      signal = "WAIT";
      reason =
        "15m confirmation is still building";
    }

    /*
      Risk levels are generated ONLY for actual signals.
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

      price: Number(price.toFixed(2)),
      quote_price: Number(price.toFixed(2)),

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

      trend_15m: trend,

      recent_high:
        Number(recentHigh.toFixed(2)),

      recent_low:
        Number(recentLow.toFixed(2)),

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

      volume_confirmed:
        volumeConfirmed,

      price_gap_pct:
        Number(priceGap.toFixed(2)),

      intraday_points:
        intraday.points
    };

  } catch (error) {
    console.error(
      `${symbol}: scan error:`,
      error.stack || error.message || error
    );

    return {
      symbol,
      signal: "UNAVAILABLE",
      reason:
        `Scanner error: ${error.message}`,
      price: null,
      quote_price: null,
      ema20: null,
      rsi14: null,
      vwap: null,
      relative_volume: null,
      trend_15m: "UNAVAILABLE",
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

/* ---------------------------------------------------------
   MAIN
--------------------------------------------------------- */

async function main() {
  console.log("======================================");
  console.log("₹1,000 INTRADAY SCANNER");
  console.log("======================================");

  const universe =
    JSON.parse(
      fs.readFileSync(
        UNIVERSE_FILE,
        "utf8"
      )
    );

  const symbols =
    Array.isArray(universe)
      ? universe
      : universe.symbols;

  if (!Array.isArray(symbols) || !symbols.length) {
    throw new Error(
      "No symbols found in data/universe.json"
    );
  }

  const session =
    indiaSessionRange();

  console.log(
    `India session: ${session.date} ${SIGNAL_START}-${SIGNAL_END} IST`
  );

  console.log(
    `Scanning ${symbols.length} stocks...`
  );

  /*
    Small delay between batches to reduce pressure
    on NSE endpoints.
  */
  const results = [];

  for (const symbol of symbols) {
    const result =
      await scanStock(symbol);

    results.push(result);

    await sleep(250);
  }

  const buyCount =
    results.filter(r => r.signal === "BUY").length;

  const sellCount =
    results.filter(r => r.signal === "SELL").length;

  const waitCount =
    results.filter(r => r.signal === "WAIT").length;

  const unavailableCount =
    results.filter(
      r => r.signal === "UNAVAILABLE"
    ).length;

  const output = {
    updated_at: new Date().toISOString(),

    timezone: "Asia/Kolkata",

    market: "NSE",

    provider:
      "NSE intraday + chart data via stock-nse-india",

    interval:
      "5m + 15m confirmation",

    session:
      "09:15-15:15 IST",

    minimum_candles: {
      "5m": MIN_5M_CANDLES,
      "15m": MIN_15M_CANDLES
    },

    summary: {
      total: results.length,
      buy: buyCount,
      sell: sellCount,
      wait: waitCount,
      unavailable: unavailableCount
    },

    data_quality:
      "Intraday grapthData is used for validated price/time. Chart OHLCV is used for EMA20, RSI14, VWAP and relative volume. IST session filtering and chart/LTP validation enabled.",

    disclaimer:
      "Educational decision-support only. Intraday signals can be delayed or wrong. Verify price, liquidity, volume and risk with your broker before trading.",

    stocks: results
  };

  /*
    Atomic write.
  */
  const tempFile =
    `${OUTPUT_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(
      output,
      null,
      2
    )
  );

  fs.renameSync(
    tempFile,
    OUTPUT_FILE
  );

  console.log("======================================");
  console.log("SCAN COMPLETE");
  console.log("======================================");

  console.log(
    `BUY: ${buyCount}`
  );

  console.log(
    `SELL: ${sellCount}`
  );

  console.log(
    `WAIT: ${waitCount}`
  );

  console.log(
    `UNAVAILABLE: ${unavailableCount}`
  );

  console.log(
    `Saved: ${OUTPUT_FILE}`
  );
}

main().catch(error => {
  console.error(
    "FATAL ERROR:",
    error.stack || error
  );

  process.exit(1);
});
