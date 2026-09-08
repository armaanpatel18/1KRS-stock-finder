const fs = require("fs");

const path = require("path");

const {

  getEquityChartHistoricalData,

  getEquityDetails,

} = require("stock-nse-india");

const UNIVERSE_FILE = path.join(__dirname, "..", "data", "universe.json");

const OUTPUT_FILE = path.join(__dirname, "..", "data", "intraday.json");

const INTERVAL_5M = "5";

const INTERVAL_15M = "15";

// Conservative NSE signal session.

// 09:15 IST = 03:45 UTC

// 15:15 IST = 09:45 UTC

const SESSION_START_UTC_HOUR = 3;

const SESSION_START_UTC_MINUTE = 45;

const SESSION_END_UTC_HOUR = 9;

const SESSION_END_UTC_MINUTE = 45;

function round(value, decimals = 2) {

  if (!Number.isFinite(value)) return null;

  const factor = 10 ** decimals;

  return Math.round(value * factor) / factor;

}

function number(value) {

  const n = Number(value);

  return Number.isFinite(n) ? n : null;

}

/**

 * Returns today's NSE session range in UTC.

 *

 * GitHub Actions runs in UTC, so we must NOT use:

 * new Date().setHours(9, 0, ...)

 *

 * because that would mean 09:00 UTC, not 09:00 IST.

 */

function todayRangeIST() {

  const parts = new Intl.DateTimeFormat("en-CA", {

    timeZone: "Asia/Kolkata",

    year: "numeric",

    month: "2-digit",

    day: "2-digit",

  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year").value;

  const month = parts.find((p) => p.type === "month").value;

  const day = parts.find((p) => p.type === "day").value;

  // 09:15 IST = 03:45 UTC

  // 15:15 IST = 09:45 UTC

  const start = new Date(

    `${year}-${month}-${day}T03:45:00.000Z`

  );

  const end = new Date(

    `${year}-${month}-${day}T09:45:00.000Z`

  );

  return { start, end };

}

function parseTimestamp(value) {

  if (value === null || value === undefined) return null;

  if (typeof value === "number") {

    // Epoch seconds

    if (value < 1e12) {

      return new Date(value * 1000);

    }

    // Epoch milliseconds

    return new Date(value);

  }

  if (typeof value === "string") {

    const numeric = Number(value);

    if (Number.isFinite(numeric)) {

      if (numeric < 1e12) {

        return new Date(numeric * 1000);

      }

      return new Date(numeric);

    }

    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {

      return date;

    }

  }

  return null;

}

function normalizeCandle(candle) {

  // stock-nse-india chart response normally uses objects:

  // { time, open, high, low, close, volume }

  if (Array.isArray(candle)) {

    const timestamp = parseTimestamp(candle[0]);

    return {

      timestamp,

      open: number(candle[1]),

      high: number(candle[2]),

      low: number(candle[3]),

      close: number(candle[4]),

      volume: number(candle[5]),

    };

  }

  if (!candle || typeof candle !== "object") {

    return null;

  }

  const timestamp = parseTimestamp(

    candle.timestamp ??

      candle.time ??

      candle.t ??

      candle.date

  );

  return {

    timestamp,

    open: number(candle.open ?? candle.o),

    high: number(candle.high ?? candle.h),

    low: number(candle.low ?? candle.l),

    close: number(candle.close ?? candle.c),

    volume: number(candle.volume ?? candle.v),

  };

}

function normalizeCandles(response) {

  let raw = [];

  if (Array.isArray(response)) {

    raw = response;

  } else if (response && Array.isArray(response.data)) {

    raw = response.data;

  } else if (

    response &&

    response.data &&

    Array.isArray(response.data.data)

  ) {

    raw = response.data.data;

  } else if (response && Array.isArray(response.candles)) {

    raw = response.candles;

  }

  return raw

    .map(normalizeCandle)

    .filter((c) => {

      if (!c || !c.timestamp) return false;

      return (

        Number.isFinite(c.open) &&

        Number.isFinite(c.high) &&

        Number.isFinite(c.low) &&

        Number.isFinite(c.close)

      );

    })

    .sort((a, b) => a.timestamp - b.timestamp);

}

function filterSession(candles) {

  const { start, end } = todayRangeIST();

  return candles.filter((c) => {

    return (

      c.timestamp >= start &&

      c.timestamp <= end

    );

  });

}

/**

 * NSE chart volume can sometimes be cumulative.

 *

 * If volumes mostly increase from candle to candle,

 * convert them into per-candle volume.

 */

function normalizeVolume(candles) {

  const result = candles.map((c) => ({ ...c }));

  const volumes = result

    .map((c) => c.volume)

    .filter((v) => Number.isFinite(v) && v >= 0);

  if (volumes.length < 3) {

    return result;

  }

  let increases = 0;

  for (let i = 1; i < volumes.length; i++) {

    if (volumes[i] >= volumes[i - 1]) {

      increases++;

    }

  }

  const increasingRatio =

    increases / (volumes.length - 1);

  const looksCumulative = increasingRatio >= 0.75;

  if (!looksCumulative) {

    return result;

  }

  for (let i = result.length - 1; i >= 0; i--) {

    if (i === 0) {

      result[i].volume = result[i].volume ?? null;

      continue;

    }

    const current = result[i].volume;

    const previous = result[i - 1].volume;

    if (

      Number.isFinite(current) &&

      Number.isFinite(previous)

    ) {

      const difference = current - previous;

      result[i].volume =

        difference >= 0 ? difference : null;

    } else {

      result[i].volume = null;

    }

  }

  return result;

}

function ema(values, period) {

  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let emaValue = 0;

  for (let i = 0; i < period; i++) {

    emaValue += values[i];

  }

  emaValue /= period;

  for (let i = period; i < values.length; i++) {

    emaValue =

      (values[i] - emaValue) * multiplier +

      emaValue;

  }

  return emaValue;

}

function rsi(values, period = 14) {

  if (values.length <= period) return null;

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

    const gain = Math.max(change, 0);

    const loss = Math.max(-change, 0);

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

  return 100 - 100 / (1 + rs);

}

function calculateVWAP(candles) {

  let cumulativePriceVolume = 0;

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

        candle.close) /

      3;

    cumulativePriceVolume +=

      typicalPrice * candle.volume;

    cumulativeVolume += candle.volume;

  }

  if (cumulativeVolume <= 0) {

    return null;

  }

  return cumulativePriceVolume / cumulativeVolume;

}

function average(values) {

  const valid = values.filter((v) =>

    Number.isFinite(v)

  );

  if (!valid.length) return null;

  return (

    valid.reduce((sum, value) => sum + value, 0) /

    valid.length

  );

}

function getLatestValidCandle(candles) {

  for (let i = candles.length - 1; i >= 0; i--) {

    const c = candles[i];

    if (

      Number.isFinite(c.close) &&

      c.close > 0

    ) {

      return c;

    }

  }

  return null;

}

function getQuotePrice(details) {

  const candidates = [

    details?.priceInfo?.lastPrice,

    details?.priceInfo?.lastTradedPrice,

    details?.priceInfo?.ltp,

    details?.priceInfo?.close,

    details?.lastPrice,

    details?.lastTradedPrice,

    details?.ltp,

  ];

  for (const value of candidates) {

    const n = number(value);

    if (Number.isFinite(n) && n > 0) {

      return n;

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

function calculateRelativeVolume(candles) {

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

  const previousVolumes = candles

    .slice(-21, -1)

    .map((c) => c.volume)

    .filter((v) =>

      Number.isFinite(v) && v > 0

    );

  if (previousVolumes.length < 10) {

    return null;

  }

  const baseline = average(previousVolumes);

  if (

    !Number.isFinite(baseline) ||

    baseline <= 0

  ) {

    return null;

  }

  const relativeVolume =

    latest.volume / baseline;

  // Extreme values are more likely to indicate

  // bad/cumulative volume than a useful signal.

  if (

    !Number.isFinite(relativeVolume) ||

    relativeVolume <= 0 ||

    relativeVolume > 20

  ) {

    return null;

  }

  return relativeVolume;

}

function recentHigh(candles, lookback = 20) {

  const values = candles

    .slice(-lookback)

    .map((c) => c.high)

    .filter((v) => Number.isFinite(v));

  return values.length

    ? Math.max(...values)

    : null;

}

function recentLow(candles, lookback = 20) {

  const values = candles

    .slice(-lookback)

    .map((c) => c.low)

    .filter((v) => Number.isFinite(v));

  return values.length

    ? Math.min(...values)

    : null;

}

function isNearHigh(price, high) {

  if (!Number.isFinite(price) || !Number.isFinite(high)) {

    return false;

  }

  return price >= high * 0.995;

}

function isNearLow(price, low) {

  if (!Number.isFinite(price) || !Number.isFinite(low)) {

    return false;

  }

  return price <= low * 1.005;

}

function makeRiskLevels(price, signal) {

  if (

    !Number.isFinite(price) ||

    price <= 0

  ) {

    return {

      entry: null,

      stop_loss: null,

      target_1: null,

      target_2: null,

    };

  }

  if (signal === "BUY") {

    return {

      entry: round(price * 1.001),

      stop_loss: round(price * 0.996),

      target_1: round(price * 1.004),

      target_2: round(price * 1.008),

    };

  }

  if (signal === "SELL") {

    return {

      entry: round(price * 0.999),

      stop_loss: round(price * 1.004),

      target_1: round(price * 0.996),

      target_2: round(price * 0.992),

    };

  }

  return {

    entry: null,

    stop_loss: null,

    target_1: null,

    target_2: null,

  };

}

async function getChart(symbol, interval) {

  try {

    const { start, end } = todayRangeIST();

    const response =

      await getEquityChartHistoricalData(

        symbol,

        {

          start: start.toISOString(),

          end: end.toISOString(),

        },

        undefined,

        undefined,

        undefined,

        interval

      );

    return filterSession(

      normalizeCandles(response)

    );

  } catch (error) {

    console.error(

      `${symbol} ${interval}m chart error:`,

      error?.message || error

    );

    return [];

  }

}

async function getQuote(symbol) {

  try {

    const details =

      await getEquityDetails(symbol);

    return getQuotePrice(details);

  } catch (error) {

    console.error(

      `${symbol} quote error:`,

      error?.message || error

    );

    return null;

  }

}

async function scanSymbol(symbol) {

  try {

    const [

      raw5m,

      raw15m,

      quotePrice,

    ] = await Promise.all([

      getChart(symbol, INTERVAL_5M),

      getChart(symbol, INTERVAL_15M),

      getQuote(symbol),

    ]);

    const candles5m =

      normalizeVolume(raw5m);

    const candles15m =

      normalizeVolume(raw15m);

    // Need enough candles for EMA20 + RSI14

    if (candles5m.length < 25) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        reason: "Not enough 5m candles",

      };

    }

    if (candles15m.length < 20) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        reason: "Not enough 15m candles",

      };

    }

    const latest5m =

      getLatestValidCandle(candles5m);

    const latest15m =

      getLatestValidCandle(candles15m);

    if (!latest5m || !latest15m) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        reason: "Invalid latest candle",

      };

    }

    const chartPrice = latest5m.close;

    if (

      !Number.isFinite(chartPrice) ||

      chartPrice <= 0

    ) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        reason: "Invalid chart price",

      };

    }

    /**

     * Strong price validation.

     *

     * If NSE chart data and quote disagree by more than 3%,

     * do not create a trading signal.

     */

    const gapPct =

      priceGapPercent(

        chartPrice,

        quotePrice

      );

    if (

      !Number.isFinite(quotePrice) ||

      quotePrice <= 0

    ) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        price: round(chartPrice),

        reason: "Live quote unavailable",

      };

    }

    if (

      !Number.isFinite(gapPct) ||

      gapPct > 3

    ) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        price: round(chartPrice),

        quote_price: round(quotePrice),

        price_gap_pct: round(gapPct),

        reason:

          "Chart price differs from live quote by more than 3%",

      };

    }

    // Use live quote as the actual decision price.

    const price = quotePrice;

    const closes5m = candles5m.map(

      (c) => c.close

    );

    const closes15m = candles15m.map(

      (c) => c.close

    );

    const ema20 = ema(closes5m, 20);

    const rsi14 = rsi(closes5m, 14);

    const vwapValue =

      calculateVWAP(candles5m);

    const ema20_15m =

      ema(closes15m, 20);

    if (

      !Number.isFinite(ema20) ||

      !Number.isFinite(rsi14) ||

      !Number.isFinite(vwapValue) ||

      !Number.isFinite(ema20_15m)

    ) {

      return {

        symbol,

        signal: "UNAVAILABLE",

        price: round(price),

        quote_price: round(quotePrice),

        reason:

          "Required indicators unavailable",

      };

    }

    const relativeVolume =

      calculateRelativeVolume(candles5m);

    const high =

      recentHigh(candles5m, 20);

    const low =

      recentLow(candles5m, 20);

    const trend15m =

      latest15m.close > ema20_15m

        ? "BULLISH"

        : latest15m.close < ema20_15m

          ? "BEARISH"

          : "NEUTRAL";

    /**

     * IMPORTANT:

     * Without valid volume confirmation,

     * BUY/SELL is impossible.

     */

    if (!Number.isFinite(relativeVolume)) {

      return {

        symbol,

        signal: "WATCH",

        price: round(price),

        quote_price: round(quotePrice),

        ema20: round(ema20),

        rsi14: round(rsi14),

        vwap: round(vwapValue),

        relative_volume: null,

        trend_15m: trend15m,

        recent_high: round(high),

        recent_low: round(low),

        volume_confirmed: false,

        session:

          "09:15-15:15 IST",

        reason:

          "Volume confirmation unavailable",

      };

    }

    const bullish5m =

      price > ema20 &&

      price > vwapValue &&

      rsi14 >= 52 &&

      rsi14 <= 70 &&

      relativeVolume >= 1.2 &&

      isNearHigh(price, high);

    const bearish5m =

      price < ema20 &&

      price < vwapValue &&

      rsi14 >= 30 &&

      rsi14 <= 48 &&

      relativeVolume >= 1.2 &&

      isNearLow(price, low);

    let signal = "WATCH";

    let reason =

      "Conditions not strong enough";

    if (

      bullish5m &&

      trend15m === "BULLISH"

    ) {

      signal = "BUY";

      reason =

        "5m trend bullish, above EMA20/VWAP, RSI supportive, volume confirmed and 15m trend bullish";

    } else if (

      bearish5m &&

      trend15m === "BEARISH"

    ) {

      signal = "SELL";

      reason =

        "5m trend bearish, below EMA20/VWAP, RSI supportive, volume confirmed and 15m trend bearish";

    }

    const risk =

      makeRiskLevels(price, signal);

    return {

      symbol,

      signal,

      price: round(price),

      quote_price: round(quotePrice),

      ema20: round(ema20),

      rsi14: round(rsi14),

      vwap: round(vwapValue),

      relative_volume:

        round(relativeVolume),

      trend_15m: trend15m,

      recent_high: round(high),

      recent_low: round(low),

      entry: risk.entry,

      stop_loss: risk.stop_loss,

      target_1: risk.target_1,

      target_2: risk.target_2,

      price_gap_pct: round(gapPct),

      volume_confirmed: true,

      session:

        "09:15-15:15 IST",

      reason,

    };

  } catch (error) {

    console.error(

      `${symbol} scanner error:`,

      error?.message || error

    );

    return {

      symbol,

      signal: "UNAVAILABLE",

      reason:

        error?.message ||

        "Scanner error",

    };

  }

}

async function main() {

  console.log(

    "Starting token-free NSE intraday scanner..."

  );

  console.log(

    "Signal session: 09:15-15:15 IST"

  );

  const universe = JSON.parse(

    fs.readFileSync(

      UNIVERSE_FILE,

      "utf8"

    )

  );

  const symbols = Array.isArray(universe)

    ? universe

    : universe.symbols || [];

  if (!symbols.length) {

    throw new Error(

      "No symbols found in data/universe.json"

    );

  }

  console.log(

    `Scanning ${symbols.length} symbols...`

  );

  const results = [];

  // Process in small batches to avoid hammering NSE.

  const batchSize = 5;

  for (

    let i = 0;

    i < symbols.length;

    i += batchSize

  ) {

    const batch =

      symbols.slice(i, i + batchSize);

    console.log(

      `Processing ${i + 1}-${Math.min(

        i + batchSize,

        symbols.length

      )}...`

    );

    const batchResults =

      await Promise.all(

        batch.map((symbol) =>

          scanSymbol(

            typeof symbol === "string"

              ? symbol

              : symbol.symbol

          )

        )

      );

    results.push(...batchResults);

    // Small pause between batches.

    if (i + batchSize < symbols.length) {

      await new Promise((resolve) =>

        setTimeout(resolve, 1000)

      );

    }

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

        "Latest 5m volume / average previous 20 5m candles",

      trend_confirmation:

        "15m price vs EMA20",

      buy:

        "Price > EMA20 + VWAP, RSI 52-70, relative volume >= 1.2x, near recent high, 15m bullish",

      sell:

        "Price < EMA20 + VWAP, RSI 30-48, relative volume >= 1.2x, near recent low, 15m bearish",

      risk:

        "Stop 0.4%, Target 1 0.4%, Target 2 0.8%",

    },

    data_quality:

      "IST session filtering, quote cross-check, epoch timestamp handling and volume validation enabled.",

    stocks: results,

  };

  fs.mkdirSync(

    path.dirname(OUTPUT_FILE),

    { recursive: true }

  );

  // Atomic write.

  const tempFile =

    `${OUTPUT_FILE}.tmp`;

  fs.writeFileSync(

    tempFile,

    JSON.stringify(

      output,

      null,

      2

    ),

    "utf8"

  );

  fs.renameSync(

    tempFile,

    OUTPUT_FILE

  );

  const counts = results.reduce(

    (acc, item) => {

      acc[item.signal] =

        (acc[item.signal] || 0) + 1;

      return acc;

    },

    {}

  );

  console.log(

    "Scanner completed."

  );

  console.log(

    "Signal summary:",

    counts

  );

  console.log(

    `Saved ${results.length} stocks to ${OUTPUT_FILE}`

  );

}

main().catch((error) => {

  console.error(

    "Fatal scanner error:",

    error

  );

  process.exit(1);

});
