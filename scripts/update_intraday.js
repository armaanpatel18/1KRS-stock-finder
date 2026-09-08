const fs = require("fs");
const path = require("path");
const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

const UNIVERSE_FILE = path.join(__dirname, "..", "data", "universe.json");
const OUTPUT_FILE = path.join(__dirname, "..", "data", "intraday.json");

const BUDGET = 1000;

// Conservative signal settings
const STOP_PCT = 0.004;       // 0.4%
const TARGET1_PCT = 0.004;    // 0.4%
const TARGET2_PCT = 0.008;    // 0.8%

const SESSION_START = "09:15";
const SESSION_END = "15:15";


// ------------------------------------------------------------
// INDIA DATE / TIME HELPERS
// ------------------------------------------------------------

function indiaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const result = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      result[p.type] = p.value;
    }
  }

  return result;
}


function indiaDateString(date = new Date()) {
  const p = indiaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}


function indiaTimeString(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}


function indiaDateTimeString(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}


// ------------------------------------------------------------
// DATE RANGE
// ------------------------------------------------------------

function chartRange() {
  const now = new Date();

  // Request a few days of history.
  // This gives EMA/RSI enough warm-up candles.
  const start = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
  const end = now;

  return { start, end };
}


// ------------------------------------------------------------
// NUMBER HELPERS
// ------------------------------------------------------------

function number(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}


function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = Math.pow(10, decimals);

  return Math.round(value * factor) / factor;
}


function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


// ------------------------------------------------------------
// NORMALIZE CHART DATA
// ------------------------------------------------------------

function normalizeCandles(response) {
  if (!response || !Array.isArray(response.data)) {
    return [];
  }

  const output = [];

  for (const candle of response.data) {
    if (!candle) continue;

    const timestamp = number(candle.time ?? candle.timestamp ?? candle.t);

    const open = number(candle.open);
    const high = number(candle.high);
    const low = number(candle.low);
    const close = number(candle.close);
    const volume = number(candle.volume);

    if (
      timestamp === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      continue;
    }

    // stock-nse-india returns epoch milliseconds.
    const timestampMs =
      timestamp < 1000000000000
        ? timestamp * 1000
        : timestamp;

    output.push({
      timestamp: timestampMs,
      open,
      high,
      low,
      close,
      volume
    });
  }

  output.sort((a, b) => a.timestamp - b.timestamp);

  return output;
}


// ------------------------------------------------------------
// SESSION FILTER
// ------------------------------------------------------------

function isCurrentSessionCandle(candle, today) {
  const date = new Date(candle.timestamp);

  const indiaDate = indiaDateString(date);

  if (indiaDate !== today) {
    return false;
  }

  const time = indiaTimeString(candle.timestamp);

  return (
    time >= SESSION_START &&
    time <= SESSION_END
  );
}


// ------------------------------------------------------------
// EMA
// ------------------------------------------------------------

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result = 0;

  // Initial SMA
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


// ------------------------------------------------------------
// RSI
// ------------------------------------------------------------

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
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

  const relativeStrength =
    averageGain / averageLoss;

  return 100 - (100 / (1 + relativeStrength));
}


// ------------------------------------------------------------
// VWAP — TODAY ONLY
// ------------------------------------------------------------

function calculateVWAP(candles) {
  if (!candles.length) {
    return null;
  }

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const volume = number(candle.volume);

    if (volume === null || volume <= 0) {
      continue;
    }

    const typicalPrice =
      (candle.high +
        candle.low +
        candle.close) / 3;

    cumulativePV += typicalPrice * volume;
    cumulativeVolume += volume;
  }

  if (cumulativeVolume <= 0) {
    return null;
  }

  return cumulativePV / cumulativeVolume;
}


// ------------------------------------------------------------
// VOLUME
// ------------------------------------------------------------

function normalizeVolumes(candles) {
  if (!candles.length) {
    return candles;
  }

  const volumes = candles.map(c => c.volume);

  const valid = volumes.filter(
    v => Number.isFinite(v) && v >= 0
  );

  if (valid.length < 3) {
    return candles;
  }

  // Detect cumulative volume.
  let increasing = 0;

  for (let i = 1; i < valid.length; i++) {
    if (valid[i] >= valid[i - 1]) {
      increasing++;
    }
  }

  const increasingRatio =
    increasing / (valid.length - 1);

  if (increasingRatio < 0.75) {
    return candles;
  }

  // Convert cumulative -> candle volume.
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
        difference >= 0
          ? difference
          : null;
    }

    previous = current;
  }

  return candles;
}


// ------------------------------------------------------------
// RELATIVE VOLUME
// ------------------------------------------------------------

function relativeVolume(todayCandles) {
  if (todayCandles.length < 3) {
    return null;
  }

  const current = todayCandles[todayCandles.length - 1];

  if (
    !Number.isFinite(current.volume) ||
    current.volume <= 0
  ) {
    return null;
  }

  // Use previous completed candles.
  const previous = todayCandles
    .slice(0, -1)
    .map(c => c.volume)
    .filter(v =>
      Number.isFinite(v) &&
      v > 0
    );

  if (previous.length < 2) {
    return null;
  }

  const lookback = previous.slice(-10);

  const average =
    lookback.reduce(
      (sum, value) => sum + value,
      0
    ) / lookback.length;

  if (average <= 0) {
    return null;
  }

  const result =
    current.volume / average;

  // Extremely large values usually indicate
  // bad/cumulative volume data.
  if (result > 20) {
    return null;
  }

  return result;
}


// ------------------------------------------------------------
// CURRENT PRICE
// ------------------------------------------------------------

async function getCurrentPrice(symbol) {
  try {
    const response =
      await nse.getEquityIntradayData(symbol);

    const closePrice =
      number(response?.closePrice);

    if (closePrice !== null && closePrice > 0) {
      return closePrice;
    }

    if (
      Array.isArray(response?.grapthData) &&
      response.grapthData.length
    ) {
      const last =
        response.grapthData[
          response.grapthData.length - 1
        ];

      const price = number(last?.[1]);

      if (price !== null && price > 0) {
        return price;
      }
    }

  } catch (error) {
    console.log(
      `${symbol}: intraday quote unavailable`
    );
  }

  return null;
}


// ------------------------------------------------------------
// PRICE VALIDATION
// ------------------------------------------------------------

function priceGapPercent(price, quote) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(quote) ||
    quote === 0
  ) {
    return null;
  }

  return Math.abs(
    (price - quote) / quote
  ) * 100;
}


// ------------------------------------------------------------
// ₹1,000 POSITION SIZE
// ------------------------------------------------------------

function positionSize(entry, direction) {
  if (
    !Number.isFinite(entry) ||
    entry <= 0
  ) {
    return {
      quantity: 0,
      capital: null,
      risk: null,
      target1_profit: null,
      target2_profit: null,
      stop_loss: null,
      target_1: null,
      target_2: null
    };
  }

  const quantity =
    Math.floor(BUDGET / entry);

  if (quantity <= 0) {
    return {
      quantity: 0,
      capital: 0,
      risk: 0,
      target1_profit: 0,
      target2_profit: 0,
      stop_loss: null,
      target_1: null,
      target_2: null
    };
  }

  let stopLoss;
  let target1;
  let target2;

  if (direction === "BUY") {
    stopLoss = entry * (1 - STOP_PCT);
    target1 = entry * (1 + TARGET1_PCT);
    target2 = entry * (1 + TARGET2_PCT);
  } else {
    stopLoss = entry * (1 + STOP_PCT);
    target1 = entry * (1 - TARGET1_PCT);
    target2 = entry * (1 - TARGET2_PCT);
  }

  const capital = quantity * entry;

  const risk =
    Math.abs(entry - stopLoss) *
    quantity;

  const target1Profit =
    Math.abs(target1 - entry) *
    quantity;

  const target2Profit =
    Math.abs(target2 - entry) *
    quantity;

  return {
    quantity,
    capital: round(capital),
    risk: round(risk),
    target1_profit: round(target1Profit),
    target2_profit: round(target2Profit),
    stop_loss: round(stopLoss),
    target_1: round(target1),
    target_2: round(target2)
  };
}


// ------------------------------------------------------------
// SCAN ONE STOCK
// ------------------------------------------------------------

async function scanStock(symbol) {
  try {
    console.log(`Scanning ${symbol}...`);

    const range = chartRange();

    const response =
      await nse.getEquityChartHistoricalData(
        symbol,
        range,
        undefined,
        "Equity",
        "I",
        "15"
      );

    let candles =
      normalizeCandles(response);

    if (!candles.length) {
      return {
        symbol,
        signal: "UNAVAILABLE",
        reason: "No 15m chart data returned",
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

    candles = normalizeVolumes(candles);

    const today =
      indiaDateString();

    const todayCandles =
      candles.filter(c =>
        isCurrentSessionCandle(c, today)
      );

    // --------------------------------------------------------
    // CURRENT PRICE
    // --------------------------------------------------------

    const quotePrice =
      await getCurrentPrice(symbol);

    const latestChart =
      todayCandles.length
        ? todayCandles[todayCandles.length - 1]
        : null;

    let price =
      quotePrice ??
      latestChart?.close ??
      null;

    // --------------------------------------------------------
    // NO TODAY DATA
    // --------------------------------------------------------

    if (!todayCandles.length) {
      return {
        symbol,
        signal: "WAIT",
        reason: "Waiting for today's 15m intraday data",
        price: round(price),
        quote_price: round(quotePrice),
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

    // --------------------------------------------------------
    // PRICE VALIDATION
    // --------------------------------------------------------

    if (
      quotePrice !== null &&
      latestChart?.close !== null &&
      latestChart?.close !== undefined
    ) {
      const gap =
        priceGapPercent(
          latestChart.close,
          quotePrice
        );

      if (
        gap !== null &&
        gap > 3
      ) {
        return {
          symbol,
          signal: "UNAVAILABLE",
          reason: `Chart/quote price mismatch (${round(gap, 2)}%)`,
          price: round(latestChart.close),
          quote_price: round(quotePrice),
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

    // --------------------------------------------------------
    // INDICATOR WARM-UP
    // Historical candles + today.
    // --------------------------------------------------------

    const closes =
      candles.map(c => c.close);

    const ema20 =
      ema(closes, 20);

    const rsi14 =
      rsi(closes, 14);

    // --------------------------------------------------------
    // TODAY-ONLY INDICATORS
    // --------------------------------------------------------

    const vwapValue =
      calculateVWAP(todayCandles);

    const recentHigh =
      Math.max(
        ...todayCandles.map(c => c.high)
      );

    const recentLow =
      Math.min(
        ...todayCandles.map(c => c.low)
      );

    const relativeVol =
      relativeVolume(todayCandles);

    const volumeConfirmed =
      relativeVol !== null &&
      relativeVol >= 1.2;

    // --------------------------------------------------------
    // TREND
    // --------------------------------------------------------

    let trend = "BUILDING";

    if (
      ema20 !== null &&
      price !== null
    ) {
      if (price > ema20) {
        trend = "BULLISH";
      } else if (price < ema20) {
        trend = "BEARISH";
      } else {
        trend = "NEUTRAL";
      }
    }

    // --------------------------------------------------------
    // INSUFFICIENT INDICATOR DATA
    // --------------------------------------------------------

    if (
      ema20 === null ||
      rsi14 === null ||
      vwapValue === null
    ) {
      return {
        symbol,
        signal: "WAIT",
        reason: "Building indicator history",
        price: round(price),
        quote_price: round(quotePrice),
        ema20: round(ema20),
        rsi14: round(rsi14),
        vwap: round(vwapValue),
        relative_volume: round(relativeVol),
        trend_15m: trend,
        recent_high: round(recentHigh),
        recent_low: round(recentLow),
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

    // --------------------------------------------------------
    // ENTRY CONDITIONS
    // --------------------------------------------------------

    const nearHigh =
      price >= recentHigh * 0.998;

    const nearLow =
      price <= recentLow * 1.002;

    const bullish =
      price > ema20 &&
      price > vwapValue &&
      rsi14 >= 52 &&
      rsi14 <= 70 &&
      volumeConfirmed &&
      nearHigh;

    const bearish =
      price < ema20 &&
      price < vwapValue &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      volumeConfirmed &&
      nearLow;

    let signal = "WATCH";
    let reason = "Mixed conditions";

    if (bullish) {
      signal = "BUY";
      reason =
        "Price above EMA20/VWAP, bullish RSI, strong volume and near recent high";
    } else if (bearish) {
      signal = "SELL";
      reason =
        "Price below EMA20/VWAP, bearish RSI, strong volume and near recent low";
    } else if (!volumeConfirmed) {
      reason =
        relativeVol === null
          ? "Volume confirmation unavailable"
          : `Relative volume ${round(relativeVol, 2)}x is below 1.2x`;
    }

    // --------------------------------------------------------
    // ₹1,000 TRADE CALCULATION
    // --------------------------------------------------------

    let trade = {
      quantity: 0,
      capital: null,
      risk: null,
      target1_profit: null,
      target2_profit: null,
      stop_loss: null,
      target_1: null,
      target_2: null
    };

    if (
      signal === "BUY" ||
      signal === "SELL"
    ) {
      trade =
        positionSize(
          price,
          signal
        );
    }

    const riskReward1 =
      trade.risk > 0
        ? trade.target1_profit / trade.risk
        : null;

    const riskReward2 =
      trade.risk > 0
        ? trade.target2_profit / trade.risk
        : null;

    return {
      symbol,
      signal,
      reason,

      price: round(price),
      quote_price: round(quotePrice),

      ema20: round(ema20),
      rsi14: round(rsi14),
      vwap: round(vwapValue),

      relative_volume:
        round(relativeVol),

      trend_15m: trend,

      recent_high:
        round(recentHigh),

      recent_low:
        round(recentLow),

      entry:
        signal === "BUY" ||
        signal === "SELL"
          ? round(price)
          : null,

      stop_loss:
        trade.stop_loss,

      target_1:
        trade.target_1,

      target_2:
        trade.target_2,

      capital:
        trade.capital,

      quantity:
        trade.quantity,

      risk:
        trade.risk,

      target1_profit:
        trade.target1_profit,

      target2_profit:
        trade.target2_profit,

      risk_reward_1:
        round(riskReward1),

      risk_reward_2:
        round(riskReward2),

      volume_confirmed:
        volumeConfirmed,

      session:
        `${SESSION_START}-${SESSION_END} IST`,

      timeframe:
        "15m",

      data_quality:
        "Historical warm-up + current-session VWAP/volume + quote validation"
    };

  } catch (error) {
    console.error(
      `${symbol} ERROR:`,
      error?.message || error
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
      trend_15m: "UNAVAILABLE",
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


// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

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
      : Array.isArray(universe?.symbols)
        ? universe.symbols
        : [];

  if (!symbols.length) {
    throw new Error(
      "No symbols found in data/universe.json"
    );
  }

  console.log(
    `Scanning ${symbols.length} symbols...`
  );

  const results = [];

  for (const symbol of symbols) {
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
      "15m",

    budget:
      BUDGET,

    session:
      "09:15-15:15 IST",

    methodology:
      {
        indicator_warmup:
          "Historical + current candles",

        vwap:
          "Current session only",

        relative_volume:
          "Current session candle vs previous completed candles",

        price_validation:
          "Chart vs NSE intraday quote",

        stop_loss:
          "0.4%",

        target_1:
          "0.4%",

        target_2:
          "0.8%"
      },

    stocks:
      results
  };

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      output,
      null,
      2
    )
  );

  console.log(
    `\nSaved ${results.length} results to data/intraday.json`
  );

  const summary =
    results.reduce(
      (acc, item) => {
        acc[item.signal] =
          (acc[item.signal] || 0) + 1;

        return acc;
      },
      {}
    );

  console.log("\nSIGNAL SUMMARY:");
  console.log(summary);
}


main().catch(error => {
  console.error(error);
  process.exit(1);
});
