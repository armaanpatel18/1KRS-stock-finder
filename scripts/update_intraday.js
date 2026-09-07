const fs = require("fs");
const { NseIndia } = require("stock-nse-india");

const universe = JSON.parse(
  fs.readFileSync("data/universe.json", "utf8")
);

const symbols = universe.symbols || [];

const nseIndia = new NseIndia();

function todayRange() {
  const now = new Date();

  const start = new Date(now);
  start.setHours(9, 0, 0, 0);

  const end = new Date(now);
  end.setHours(15, 35, 0, 0);

  return {
    start,
    end
  };
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value =
    values
      .slice(0, period)
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

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function vwap(candles) {
  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    if (!Number.isFinite(c.volume) || c.volume < 0) {
      continue;
    }

    const typical =
      (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    volume += c.volume;
  }

  return volume > 0 ? pv / volume : null;
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
        timestamp:
          c.timestamp ||
          c.time ||
          c.t,

        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      };

    })
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.close > 0 &&
      c.high > 0 &&
      c.low > 0
    )
    .sort((a, b) =>
      new Date(a.timestamp) -
      new Date(b.timestamp)
    );
}

/*
 * Some chart sources can return cumulative volume
 * rather than per-candle volume.
 *
 * If volume is mostly increasing, convert it to
 * candle-by-candle volume before calculating
 * relative volume.
 */
function normalizeVolume(candles) {

  if (candles.length < 5) {
    return candles;
  }

  const volumes = candles.map(c => c.volume);

  let increasing = 0;
  let comparisons = 0;

  for (let i = 1; i < volumes.length; i++) {

    if (
      Number.isFinite(volumes[i]) &&
      Number.isFinite(volumes[i - 1])
    ) {
      comparisons++;

      if (volumes[i] >= volumes[i - 1]) {
        increasing++;
      }
    }
  }

  const mostlyIncreasing =
    comparisons > 0 &&
    increasing / comparisons >= 0.70;

  if (!mostlyIncreasing) {
    return candles;
  }

  return candles.map((c, i) => {

    if (i === 0) {
      return {
        ...c,
        volume: 0
      };
    }

    const difference =
      candles[i].volume -
      candles[i - 1].volume;

    return {
      ...c,
      volume:
        Number.isFinite(difference) &&
        difference >= 0
          ? difference
          : 0
    };

  });
}

function average(values) {

  const valid = values.filter(
    v => Number.isFinite(v) && v >= 0
  );

  if (!valid.length) return null;

  return (
    valid.reduce((a, b) => a + b, 0) /
    valid.length
  );
}

function isReasonablePrice(chartPrice, quotePrice) {

  if (
    !Number.isFinite(chartPrice) ||
    chartPrice <= 0
  ) {
    return false;
  }

  if (
    !Number.isFinite(quotePrice) ||
    quotePrice <= 0
  ) {
    return true;
  }

  /*
   * Reject obviously corrupted chart prices.
   * A legitimate intraday price should not normally
   * differ from the current NSE quote by this much.
   */
  const difference =
    Math.abs(chartPrice - quotePrice) /
    quotePrice;

  return difference <= 0.20;
}

function getQuotePrice(details) {

  const candidates = [
    details?.priceInfo?.lastPrice,
    details?.priceInfo?.close,
    details?.lastPrice,
    details?.last_price
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

async function scanSymbol(symbol) {

  try {

    const range = todayRange();

    /*
     * Get today's 5-minute candles only.
     */
    const data5m =
      await nseIndia.getEquityChartHistoricalData(
        symbol,
        range,
        undefined,
        "Equity",
        "I",
        "5"
      );

    let candles5m =
      normalize(data5m);

    candles5m =
      normalizeVolume(candles5m);

    /*
     * Get today's 15-minute candles for confirmation.
     */
    const data15m =
      await nseIndia.getEquityChartHistoricalData(
        symbol,
        range,
        undefined,
        "Equity",
        "I",
        "15"
      );

    let candles15m =
      normalize(data15m);

    candles15m =
      normalizeVolume(candles15m);

    /*
     * Require enough 5m candles for indicators.
     */
    if (candles5m.length < 25) {

      return {
        symbol,
        signal: "UNAVAILABLE",
        reason: "Insufficient 5-minute data"
      };

    }

    const closes =
      candles5m.map(c => c.close);

    const price =
      closes[closes.length - 1];

    /*
     * Validate the chart price against NSE quote data.
     */
    let quotePrice = null;

    try {

      const details =
        await nseIndia.getEquityDetails(symbol);

      quotePrice =
        getQuotePrice(details);

    } catch (quoteError) {

      console.log(
        `Quote unavailable: ${symbol}`
      );

    }

    if (
      !isReasonablePrice(
        price,
        quotePrice
      )
    ) {

      console.log(
        `Rejected suspicious price: ${symbol} chart=${price} quote=${quotePrice}`
      );

      return {
        symbol,
        signal: "UNAVAILABLE",
        price: null,
        reason: "Suspicious price data rejected"
      };

    }

    const ema20 =
      ema(closes, 20);

    const rsi14 =
      rsi(closes, 14);

    const currentVwap =
      vwap(candles5m);

    /*
     * 15-minute confirmation.
     */
    let trend15m = "NEUTRAL";

    if (candles15m.length >= 20) {

      const closes15m =
        candles15m.map(c => c.close);

      const price15m =
        closes15m[closes15m.length - 1];

      const ema20_15m =
        ema(closes15m, 20);

      if (
        ema20_15m &&
        price15m > ema20_15m
      ) {
        trend15m = "BULLISH";
      }

      if (
        ema20_15m &&
        price15m < ema20_15m
      ) {
        trend15m = "BEARISH";
      }

    }

    /*
     * Recent 5m high / low.
     */
    const recent =
      candles5m.slice(-6);

    const recentHigh =
      Math.max(
        ...recent.map(c => c.high)
      );

    const recentLow =
      Math.min(
        ...recent.map(c => c.low)
      );

    /*
     * Relative volume:
     * compare the latest completed candle
     * with previous 20 candles.
     */
    const lastVolume =
      candles5m[candles5m.length - 1].volume;

    const previous =
      candles5m.slice(
        Math.max(
          0,
          candles5m.length - 21
        ),
        candles5m.length - 1
      );

    const avgVolume =
      average(
        previous.map(c => c.volume)
      );

    let relativeVolume = null;

    if (
      avgVolume !== null &&
      avgVolume > 0
    ) {

      relativeVolume =
        lastVolume / avgVolume;

    }

    /*
     * Guard against absurd relative volume.
     */
    if (
      relativeVolume !== null &&
      (
        relativeVolume < 0 ||
        relativeVolume > 20
      )
    ) {

      relativeVolume = null;

    }

    const nearHigh =
      price >= recentHigh * 0.997;

    const nearLow =
      price <= recentLow * 1.003;

    let signal = "WATCH";

    let reason =
      "Mixed conditions";

    /*
     * BUY:
     *
     * 5m price > EMA20
     * 5m price > VWAP
     * RSI 52-70
     * Relative volume >= 1.2
     * Near recent high
     * 15m trend bullish
     */
    if (
      ema20 &&
      currentVwap &&
      relativeVolume !== null &&
      trend15m === "BULLISH" &&
      price > ema20 &&
      price > currentVwap &&
      rsi14 >= 52 &&
      rsi14 <= 70 &&
      relativeVolume >= 1.2 &&
      nearHigh
    ) {

      signal = "BUY";

      reason =
        "5m trend bullish with price above EMA20/VWAP, strong volume and 15m confirmation";

    }

    /*
     * SELL:
     *
     * 5m price < EMA20
     * 5m price < VWAP
     * RSI 30-48
     * Relative volume >= 1.2
     * Near recent low
     * 15m trend bearish
     */
    else if (
      ema20 &&
      currentVwap &&
      relativeVolume !== null &&
      trend15m === "BEARISH" &&
      price < ema20 &&
      price < currentVwap &&
      rsi14 >= 30 &&
      rsi14 <= 48 &&
      relativeVolume >= 1.2 &&
      nearLow
    ) {

      signal = "SELL";

      reason =
        "5m trend bearish with price below EMA20/VWAP, strong volume and 15m confirmation";

    }

    /*
     * Risk levels.
     */
    const entry =
      Number(price.toFixed(2));

    const stopLoss =
      signal === "SELL"
        ? price * 1.004
        : price * 0.996;

    const target1 =
      signal === "SELL"
        ? price * 0.996
        : price * 1.004;

    const target2 =
      signal === "SELL"
        ? price * 0.992
        : price * 1.008;

    return {

      symbol,

      signal,

      price:
        Number(price.toFixed(2)),

      quote_price:
        quotePrice !== null
          ? Number(quotePrice.toFixed(2))
          : null,

      ema20:
        ema20 !== null
          ? Number(ema20.toFixed(2))
          : null,

      rsi14:
        rsi14 !== null
          ? Number(rsi14.toFixed(2))
          : null,

      vwap:
        currentVwap !== null
          ? Number(currentVwap.toFixed(2))
          : null,

      relative_volume:
        relativeVolume !== null
          ? Number(relativeVolume.toFixed(2))
          : null,

      trend_15m:
        trend15m,

      recent_high:
        Number(recentHigh.toFixed(2)),

      recent_low:
        Number(recentLow.toFixed(2)),

      entry,

      stop_loss:
        Number(stopLoss.toFixed(2)),

      target_1:
        Number(target1.toFixed(2)),

      target_2:
        Number(target2.toFixed(2)),

      reason

    };

  } catch (error) {

    console.error(
      `Failed: ${symbol}`,
      error.message
    );

    return {

      symbol,

      signal: "UNAVAILABLE",

      price: null,

      reason:
        "Data source unavailable"

    };

  }

}

async function main() {

  console.log(
    `Scanning ${symbols.length} NSE stocks...`
  );

  const stocks = [];

  for (const symbol of symbols) {

    console.log(
      `Scanning ${symbol}`
    );

    const result =
      await scanSymbol(symbol);

    stocks.push(result);

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

    data_quality:
      "Chart prices are checked against NSE quote data; suspicious values are rejected.",

    stocks

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
    "Intraday data updated."
  );

}

main().catch(error => {

  console.error(error);

  process.exit(1);

});
