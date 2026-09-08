const fs = require("fs");
const path = require("path");

const {
  getEquityChartHistoricalData,
  getEquityDetails,
} = require("stock-nse-india");

const UNIVERSE_FILE = path.join(
  __dirname,
  "..",
  "data",
  "universe.json"
);

const OUTPUT_FILE = path.join(
  __dirname,
  "..",
  "data",
  "intraday.json"
);

const INTERVAL_5M = "5";
const INTERVAL_15M = "15";

/*
  NSE signal calculation window:

  09:15 IST = 03:45 UTC
  15:15 IST = 09:45 UTC

  GitHub Actions runs in UTC, so we explicitly construct
  the Indian market session in UTC.
*/

function getIndiaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find(
    (p) => p.type === "year"
  ).value;

  const month = parts.find(
    (p) => p.type === "month"
  ).value;

  const day = parts.find(
    (p) => p.type === "day"
  ).value;

  return `${year}-${month}-${day}`;
}

function todayRangeIST() {
  const date = getIndiaDate();

  return {
    start: new Date(
      `${date}T03:45:00.000Z`
    ),
    end: new Date(
      `${date}T09:45:00.000Z`
    ),
  };
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** decimals;

  return (
    Math.round(value * factor) / factor
  );
}

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

/*
  Handles:

  - epoch seconds
  - epoch milliseconds
  - ISO timestamps
*/
function parseTimestamp(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (typeof value === "number") {
    if (value < 1e12) {
      return new Date(value * 1000);
    }

    return new Date(value);
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      if (numeric < 1e12) {
        return new Date(
          numeric * 1000
        );
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

/*
  Normalize both array and object candle formats.
*/
function normalizeCandle(candle) {
  if (Array.isArray(candle)) {
    return {
      timestamp: parseTimestamp(candle[0]),
      open: toNumber(candle[1]),
      high: toNumber(candle[2]),
      low: toNumber(candle[3]),
      close: toNumber(candle[4]),
      volume: toNumber(candle[5]),
    };
  }

  if (
    !candle ||
    typeof candle !== "object"
  ) {
    return null;
  }

  return {
    timestamp: parseTimestamp(
      candle.timestamp ??
        candle.time ??
        candle.t ??
        candle.date
    ),

    open: toNumber(
      candle.open ?? candle.o
    ),

    high: toNumber(
      candle.high ?? candle.h
    ),

    low: toNumber(
      candle.low ?? candle.l
    ),

    close: toNumber(
      candle.close ?? candle.c
    ),

    volume: toNumber(
      candle.volume ?? candle.v
    ),
  };
}

function normalizeCandles(response) {
  let raw = [];

  if (Array.isArray(response)) {
    raw = response;
  } else if (
    response &&
    Array.isArray(response.data)
  ) {
    raw = response.data;
  } else if (
    response &&
    response.data &&
    Array.isArray(response.data.data)
  ) {
    raw = response.data.data;
  } else if (
    response &&
    Array.isArray(response.candles)
  ) {
    raw = response.candles;
  }

  return raw
    .map(normalizeCandle)
    .filter((c) => {
      return (
        c &&
        c.timestamp &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.close > 0
      );
    })
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp
    );
}

function filterSession(candles) {
  const { start, end } =
    todayRangeIST();

  return candles.filter(
    (c) =>
      c.timestamp >= start &&
      c.timestamp <= end
  );
}

/*
  IMPORTANT VOLUME FIX

  NSE chart APIs can return either:

  1. Per-candle volume
  OR
  2. Cumulative session volume.

  We determine whether the data looks cumulative.

  If cumulative:
      candleVolume =
          currentCumulativeVolume
          - previousCumulativeVolume

  If normal:
      keep the original volume.
*/
function normalizeVolume(candles) {
  if (!candles.length) {
    return [];
  }

  const result = candles.map(
    (c) => ({ ...c })
  );

  const valid = result.filter(
    (c) =>
      Number.isFinite(c.volume) &&
      c.volume >= 0
  );

  if (valid.length < 5) {
    return result;
  }

  let increasing = 0;
  let comparisons = 0;

  for (
    let i = 1;
    i < valid.length;
    i++
  ) {
    if (
      valid[i].volume >=
      valid[i - 1].volume
    ) {
      increasing++;
    }

    comparisons++;
  }

  const increasingRatio =
    comparisons > 0
      ? increasing / comparisons
      : 0;

  /*
    A very high percentage of increasing
    values strongly suggests cumulative volume.
  */
  const cumulative =
    increasingRatio >= 0.80;

  if (!cumulative) {
    return result;
  }

  let previous = null;

  for (const candle of result) {
    if (
      !Number.isFinite(
        candle.volume
      )
    ) {
      candle.volume = null;
      continue;
    }

    if (previous === null) {
      /*
        The first cumulative value is not
        reliable as a candle volume.
      */
      candle.volume = null;
    } else {
      const difference =
        candle.volume - previous;

      candle.volume =
        difference >= 0
          ? difference
          : null;
    }

    previous =
      Number.isFinite(
        candle.volume
      )
        ? previous
        : previous;

    /*
      Use original cumulative volume
      for the next difference.
    */
  }

  /*
    The loop above needs the original cumulative
    sequence. Rebuild it safely.
  */
  const originalVolumes =
    candles.map(
      (c) => c.volume
    );

  for (
    let i = 0;
    i < result.length;
    i++
  ) {
    const current =
      originalVolumes[i];

    if (
      !Number.isFinite(current)
    ) {
      result[i].volume = null;
      continue;
    }

    if (i === 0) {
      result[i].volume = null;
      continue;
    }

    const previousOriginal =
      originalVolumes[i - 1];

    if (
      !Number.isFinite(
        previousOriginal
      )
    ) {
      result[i].volume = null;
      continue;
    }

    const diff =
      current - previousOriginal;

    result[i].volume =
      diff >= 0 ? diff : null;
  }

  return result;
}

function ema(values, period) {
  if (
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let value = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    value += values[i];
  }

  value /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      (values[i] - value) *
        multiplier +
      value;
  }

  return value;
}

function rsi(
  values,
  period = 14
) {
  if (
    values.length <= period
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
      values[i] - values[i - 1];

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
      values[i] - values[i - 1];

    const gain =
      Math.max(change, 0);

    const loss =
      Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) +
        gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) +
        loss) /
      period;
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

    const typicalPrice =
      (candle.high +
        candle.low +
        candle.close) /
      3;

    pv +=
      typicalPrice *
      candle.volume;

    volume += candle.volume;
  }

  if (volume <= 0) {
    return null;
  }

  return pv / volume;
}

function average(values) {
  const valid =
    values.filter((v) =>
      Number.isFinite(v)
    );

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / valid.length
  );
}

function latestCandle(candles) {
  for (
    let i = candles.length - 1;
    i >= 0;
    i--
  ) {
    if (
      Number.isFinite(
        candles[i].close
      ) &&
      candles[i].close > 0
    ) {
      return candles[i];
    }
  }

  return null;
}

/*
  IMPROVED LTP EXTRACTION

  We deliberately prioritize fields that
  represent LAST TRADED PRICE.

  We do NOT use open price as LTP.
*/
function extractLTP(details) {
  const priceInfo =
    details?.priceInfo || {};

  const candidates = [
    priceInfo.lastPrice,
    priceInfo.lastTradedPrice,
    priceInfo.ltp,
    priceInfo.lastTradedPriceValue,

    details?.lastPrice,
    details?.lastTradedPrice,
    details?.ltp,
  ];

  for (const candidate of candidates) {
    const value =
      toNumber(candidate);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return null;
}

function calculatePriceGap(
  chartPrice,
  ltp
) {
  if (
    !Number.isFinite(chartPrice) ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  ) {
    return null;
  }

  return (
    Math.abs(
      chartPrice - ltp
    ) / ltp
  ) * 100;
}

function relativeVolume(candles) {
  /*
    Need latest candle + previous 20 candles.
  */
  if (candles.length < 21) {
    return null;
  }

  const latest =
    candles[candles.length - 1];

  if (
    !Number.isFinite(
      latest.volume
    ) ||
    latest.volume <= 0
  ) {
    return null;
  }

  const previous =
    candles
      .slice(-21, -1)
      .map(
        (c) => c.volume
      )
      .filter(
        (v) =>
          Number.isFinite(v) &&
          v > 0
      );

  /*
    Require enough valid candles.
  */
  if (previous.length < 10) {
    return null;
  }

  const baseline =
    average(previous);

  if (
    !Number.isFinite(
      baseline
    ) ||
    baseline <= 0
  ) {
    return null;
  }

  const value =
    latest.volume /
    baseline;

  /*
    Prevent obvious corrupted values.
  */
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 20
  ) {
    return null;
  }

  return value;
}

function recentHigh(
  candles,
  lookback = 20
) {
  const values =
    candles
      .slice(-lookback)
      .map(
        (c) => c.high
      )
      .filter(
        (v) =>
          Number.isFinite(v)
      );

  return values.length
    ? Math.max(...values)
    : null;
}

function recentLow(
  candles,
  lookback = 20
) {
  const values =
    candles
      .slice(-lookback)
      .map(
        (c) => c.low
      )
      .filter(
        (v) =>
          Number.isFinite(v)
      );

  return values.length
    ? Math.min(...values)
    : null;
}

function nearHigh(
  price,
  high
) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(high)
  ) {
    return false;
  }

  return (
    price >= high * 0.995
  );
}

function nearLow(
  price,
  low
) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(low)
  ) {
    return false;
  }

  return (
    price <= low * 1.005
  );
}

/*
  IMPORTANT:
  WATCH = no trade levels.

  BUY / SELL = levels are calculated.
*/
function riskLevels(
  price,
  signal
) {
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
      entry: round(
        price * 1.001
      ),

      stop_loss: round(
        price * 0.996
      ),

      target_1: round(
        price * 1.004
      ),

      target_2: round(
        price * 1.008
      ),
    };
  }

  if (signal === "SELL") {
    return {
      entry: round(
        price * 0.999
      ),

      stop_loss: round(
        price * 1.004
      ),

      target_1: round(
        price * 0.996
      ),

      target_2: round(
        price * 0.992
      ),
    };
  }

  return {
    entry: null,
    stop_loss: null,
    target_1: null,
    target_2: null,
  };
}

async function getChart(
  symbol,
  interval
) {
  try {
    const {
      start,
      end,
    } = todayRangeIST();

    const response =
      await getEquityChartHistoricalData(
        symbol,

        {
          start:
            start.toISOString(),

          end:
            end.toISOString(),
        },

        undefined,
        undefined,
        undefined,
        interval
      );

    const normalized =
      normalizeCandles(
        response
      );

    return filterSession(
      normalized
    );
  } catch (error) {
    console.error(
      `${symbol} ${interval}m chart error:`,
      error?.message ||
        error
    );

    return [];
  }
}

async function getDetails(
  symbol
) {
  try {
    return await getEquityDetails(
      symbol
    );
  } catch (error) {
    console.error(
      `${symbol} details error:`,
      error?.message ||
        error
    );

    return null;
  }
}

async function scanSymbol(
  symbol
) {
  try {
    const [
      raw5m,
      raw15m,
      details,
    ] = await Promise.all([
      getChart(
        symbol,
        INTERVAL_5M
      ),

      getChart(
        symbol,
        INTERVAL_15M
      ),

      getDetails(symbol),
    ]);

    const candles5m =
      normalizeVolume(
        raw5m
      );

    const candles15m =
      normalizeVolume(
        raw15m
      );

    if (
      candles5m.length < 25
    ) {
      return {
        symbol,
        signal:
          "UNAVAILABLE",
        reason:
          "Not enough 5m candles",
      };
    }

    if (
      candles15m.length < 20
    ) {
      return {
        symbol,
        signal:
          "UNAVAILABLE",
        reason:
          "Not enough 15m candles",
      };
    }

    const latest5m =
      latestCandle(
        candles5m
      );

    const latest15m =
      latestCandle(
        candles15m
      );

    if (
      !latest5m ||
      !latest15m
    ) {
      return {
        symbol,
        signal:
          "UNAVAILABLE",
        reason:
          "Latest candle invalid",
      };
    }

    const chartPrice =
      latest5m.close;

    const ltp =
      extractLTP(details);

    /*
      LTP is mandatory.
    */
    if (
      !Number.isFinite(ltp) ||
      ltp <= 0
    ) {
      return {
        symbol,
        signal:
          "UNAVAILABLE",

        price:
          round(chartPrice),

        quote_price: null,

        reason:
          "Actual LTP unavailable",
      };
    }

    const gap =
      calculatePriceGap(
        chartPrice,
        ltp
      );

    /*
      Chart and LTP should be reasonably close.
      If not, data is considered unsafe.
    */
    if (
      !Number.isFinite(gap) ||
      gap > 3
    ) {
      return {
        symbol,
        signal:
          "UNAVAILABLE",

        price:
          round(chartPrice),

        quote_price:
          round(ltp),

        price_gap_pct:
          round(gap),

        reason:
          "Chart price and LTP differ by more than 3%",
      };
    }

    /*
      Use ACTUAL LTP as the decision price.
    */
    const price = ltp;

    const closes5m =
      candles5m.map(
        (c) => c.close
      );

    const closes15m =
      candles15m.map(
        (c) => c.close
      );

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

    const vwapValue =
      calculateVWAP(
        candles5m
      );

    const ema20_15m =
      ema(
        closes15m,
        20
      );

    if (
      !Number.isFinite(ema20) ||
      !Number.isFinite(rsi14) ||
      !Number.isFinite(
        vwapValue
      ) ||
      !Number.isFinite(
        ema20_15m
      )
    ) {
      return {
        symbol,
        signal:
          "UNAVAILABLE",

        price:
          round(price),

        quote_price:
          round(ltp),

        reason:
          "Required indicator unavailable",
      };
    }

    const relVol =
      relativeVolume(
        candles5m
      );

    const high =
      recentHigh(
        candles5m
      );

    const low =
      recentLow(
        candles5m
      );

    const trend15m =
      latest15m.close >
      ema20_15m
        ? "BULLISH"
        : latest15m.close <
            ema20_15m
          ? "BEARISH"
          : "NEUTRAL";

    /*
      NO VOLUME = WATCH ONLY.
    */
    if (
      !Number.isFinite(
        relVol
      )
    ) {
      return {
        symbol,

        signal:
          "WATCH",

        price:
          round(price),

        quote_price:
          round(ltp),

        ema20:
          round(ema20),

        rsi14:
          round(rsi14),

        vwap:
          round(vwapValue),

        relative_volume:
          null,

        trend_15m:
          trend15m,

        recent_high:
          round(high),

        recent_low:
          round(low),

        entry: null,
        stop_loss: null,
        target_1: null,
        target_2: null,

        price_gap_pct:
          round(gap),

        volume_confirmed:
          false,

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
      relVol >= 1.2 &&
      nearHigh(
        price,
        high
      );

    const bearish5m =
      price < ema20 &&
      price < vwapValue &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      relVol >= 1.2 &&
      nearLow(
        price,
        low
      );

    let signal =
      "WATCH";

    let reason =
      "Mixed conditions";

    if (
      bullish5m &&
      trend15m ===
        "BULLISH"
    ) {
      signal =
        "BUY";

      reason =
        "5m bullish + above EMA20/VWAP + RSI supportive + volume confirmed + 15m bullish";
    } else if (
      bearish5m &&
      trend15m ===
        "BEARISH"
    ) {
      signal =
        "SELL";

      reason =
        "5m bearish + below EMA20/VWAP + RSI supportive + volume confirmed + 15m bearish";
    }

    const risk =
      riskLevels(
        price,
        signal
      );

    return {
      symbol,

      signal,

      price:
        round(price),

      quote_price:
        round(ltp),

      ema20:
        round(ema20),

      rsi14:
        round(rsi14),

      vwap:
        round(vwapValue),

      relative_volume:
        round(relVol),

      trend_15m:
        trend15m,

      recent_high:
        round(high),

      recent_low:
        round(low),

      entry:
        risk.entry,

      stop_loss:
        risk.stop_loss,

      target_1:
        risk.target_1,

      target_2:
        risk.target_2,

      price_gap_pct:
        round(gap),

      volume_confirmed:
        true,

      session:
        "09:15-15:15 IST",

      reason,
    };
  } catch (error) {
    console.error(
      `${symbol} scanner error:`,
      error?.message ||
        error
    );

    return {
      symbol,

      signal:
        "UNAVAILABLE",

      reason:
        error?.message ||
        "Scanner error",
    };
  }
}

async function main() {
  console.log(
    "Starting NSE intraday scanner..."
  );

  console.log(
    "Session: 09:15-15:15 IST"
  );

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
      : universe.symbols || [];

  if (!symbols.length) {
    throw new Error(
      "No symbols found in universe.json"
    );
  }

  console.log(
    `Scanning ${symbols.length} symbols...`
  );

  const results = [];

  /*
    Process 5 stocks at a time.
  */
  const batchSize = 5;

  for (
    let i = 0;
    i < symbols.length;
    i += batchSize
  ) {
    const batch =
      symbols.slice(
        i,
        i + batchSize
      );

    const batchResults =
      await Promise.all(
        batch.map(
          (item) => {
            const symbol =
              typeof item ===
              "string"
                ? item
                : item.symbol;

            return scanSymbol(
              symbol
            );
          }
        )
      );

    results.push(
      ...batchResults
    );

    if (
      i + batchSize <
      symbols.length
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            1000
          )
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
        "Latest valid 5m volume divided by average previous 20 valid 5m volumes",

      trend_confirmation:
        "15m close compared with 15m EMA20",

      buy:
        "Price > EMA20 and VWAP + RSI 52-70 + relative volume >= 1.2x + near recent high + 15m bullish",

      sell:
        "Price < EMA20 and VWAP + RSI 30-48 + relative volume >= 1.2x + near recent low + 15m bearish",

      risk:
        "Stop 0.4%, Target 1 0.4%, Target 2 0.8%",
    },

    data_quality:
      "IST session filtering, actual-LTP extraction, chart/LTP cross-check and volume validation enabled.",

    stocks:
      results,
  };

  fs.mkdirSync(
    path.dirname(
      OUTPUT_FILE
    ),
    {
      recursive: true,
    }
  );

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

  const summary =
    results.reduce(
      (acc, item) => {
        acc[item.signal] =
          (acc[item.signal] || 0) +
          1;

        return acc;
      },
      {}
    );

  console.log(
    "Scanner completed."
  );

  console.log(
    "Signal summary:",
    summary
  );

  console.log(
    `Saved ${results.length} stocks.`
  );
}

main().catch(
  (error) => {
    console.error(
      "Fatal scanner error:",
      error
    );

    process.exit(1);
  }
);
