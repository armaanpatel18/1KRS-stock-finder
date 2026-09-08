const fs = require("fs");

const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

const CAPITAL = 1000;

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

function getIndiaDate() {

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

  return `${result.year}-${result.month}-${result.day}`;

}

function timestampToMs(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) {

    return null;

  }

  // Unix seconds

  if (n < 1000000000000) {

    return n * 1000;

  }

  // Unix milliseconds

  return n;

}

function candleDateIndia(timestamp) {

  return new Intl.DateTimeFormat("en-CA", {

    timeZone: "Asia/Kolkata",

    year: "numeric",

    month: "2-digit",

    day: "2-digit"

  }).format(new Date(timestamp));

}

function candleTimeIndia(timestamp) {

  return new Intl.DateTimeFormat("en-GB", {

    timeZone: "Asia/Kolkata",

    hour: "2-digit",

    minute: "2-digit",

    second: "2-digit",

    hour12: false

  }).format(new Date(timestamp));

}

function isNseTradingTime(timestamp) {

  const time = candleTimeIndia(timestamp);

  return time >= "09:15:00" && time <= "15:15:00";

}

function normalizeCandles(response) {

  const data = Array.isArray(response?.data)

    ? response.data

    : [];

  const candles = [];

  for (const item of data) {

    if (!item) continue;

    const time = timestampToMs(

      item.time ?? item.timestamp

    );

    const open = Number(item.open);

    const high = Number(item.high);

    const low = Number(item.low);

    const close = Number(item.close);

    const volume = Number(item.volume);

    if (!Number.isFinite(time)) continue;

    if (!Number.isFinite(open)) continue;

    if (!Number.isFinite(high)) continue;

    if (!Number.isFinite(low)) continue;

    if (!Number.isFinite(close)) continue;

    if (

      open <= 0 ||

      high <= 0 ||

      low <= 0 ||

      close <= 0

    ) {

      continue;

    }

    candles.push({

      time,

      open,

      high,

      low,

      close,

      volume:

        Number.isFinite(volume) && volume >= 0

          ? volume

          : null

    });

  }

  candles.sort((a, b) => a.time - b.time);

  return candles;

}

function getTodaySessionCandles(candles) {

  const today = getIndiaDate();

  return candles.filter(c => {

    return (

      candleDateIndia(c.time) === today &&

      isNseTradingTime(c.time)

    );

  });

}

function average(values) {

  const valid = values.filter(

    v => Number.isFinite(v)

  );

  if (!valid.length) {

    return null;

  }

  return (

    valid.reduce((sum, v) => sum + v, 0) /

    valid.length

  );

}

function ema(values, period) {

  if (values.length < period) {

    return null;

  }

  const multiplier =

    2 / (period + 1);

  let result = average(

    values.slice(0, period)

  );

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

  if (values.length < period + 1) {

    return null;

  }

  let gains = 0;

  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const change =

      values[i] - values[i - 1];

    if (change > 0) {

      gains += change;

    } else {

      losses += Math.abs(change);

    }

  }

  let avgGain = gains / period;

  let avgLoss = losses / period;

  for (

    let i = period + 1;

    i < values.length;

    i++

  ) {

    const change =

      values[i] - values[i - 1];

    const gain =

      change > 0 ? change : 0;

    const loss =

      change < 0

        ? Math.abs(change)

        : 0;

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

function calculateVwap(candles) {

  let pv = 0;

  let volume = 0;

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

function calculateRelativeVolume(candles) {

  if (candles.length < 6) {

    return null;

  }

  const latest =

    candles[candles.length - 1];

  if (

    !Number.isFinite(latest.volume) ||

    latest.volume <= 0

  ) {

    return null;

  }

  const previous =

    candles

      .slice(-6, -1)

      .map(c => c.volume)

      .filter(

        v =>

          Number.isFinite(v) &&

          v > 0

      );

  if (previous.length < 3) {

    return null;

  }

  const avg =

    average(previous);

  if (

    !Number.isFinite(avg) ||

    avg <= 0

  ) {

    return null;

  }

  const result =

    latest.volume / avg;

  /*

   * Protect against obviously abnormal

   * cumulative/daily volume being returned

   * as a single candle.

   */

  if (

    !Number.isFinite(result) ||

    result > 10

  ) {

    return null;

  }

  return result;

}

function recentHigh(candles) {

  const values =

    candles

      .slice(-6)

      .map(c => c.high)

      .filter(Number.isFinite);

  return values.length

    ? Math.max(...values)

    : null;

}

function recentLow(candles) {

  const values =

    candles

      .slice(-6)

      .map(c => c.low)

      .filter(Number.isFinite);

  return values.length

    ? Math.min(...values)

    : null;

}

function getQuotePrice(details) {

  const candidates = [

    details?.priceInfo?.lastPrice,

    details?.priceInfo?.lastTradedPrice,

    details?.lastPrice,

    details?.lastTradedPrice

  ];

  for (const value of candidates) {

    const price = Number(value);

    if (

      Number.isFinite(price) &&

      price > 0

    ) {

      return price;

    }

  }

  return null;

}

function positionSize(

  entry,

  stopLoss,

  target1,

  target2

) {

  if (

    !Number.isFinite(entry) ||

    !Number.isFinite(stopLoss)

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

  const capital =

    quantity * entry;

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

    capital: Number(

      capital.toFixed(2)

    ),

    quantity,

    risk: Number(

      risk.toFixed(2)

    ),

    target1_profit: Number(

      target1Profit.toFixed(2)

    ),

    target2_profit: Number(

      target2Profit.toFixed(2)

    ),

    risk_reward_1:

      risk > 0

        ? Number(

            (

              target1Profit /

              risk

            ).toFixed(2)

          )

        : null,

    risk_reward_2:

      risk > 0

        ? Number(

            (

              target2Profit /

              risk

            ).toFixed(2)

          )

        : null

  };

}

async function scanStock(symbol) {

  try {

    const [

      chartResponse,

      details

    ] = await Promise.all([

      nse.getEquityChartHistoricalData(

        symbol,

        undefined,

        undefined,

        "Equity",

        "I",

        "15"

      ),

      nse.getEquityDetails(symbol)

    ]);

    const allCandles =

      normalizeCandles(

        chartResponse

      );

    const todayCandles =

      getTodaySessionCandles(

        allCandles

      );

    const quotePrice =

      getQuotePrice(details);

    /*

     * No current-session candles.

     */

    if (!todayCandles.length) {

      return {

        symbol,

        signal: "WAIT",

        reason:

          "Waiting for today's 15m intraday data",

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

    const closes =

      todayCandles.map(

        c => c.close

      );

    /*

     * EMA/RSI require enough current-session

     * candles. We deliberately don't fabricate

     * indicators from yesterday's data.

     */

    const ema20 =

      ema(closes, 20);

    const rsi14 =

      rsi(closes, 14);

    const vwap =

      calculateVwap(

        todayCandles

      );

    const relativeVolume =

      calculateRelativeVolume(

        todayCandles

      );

    const high =

      recentHigh(todayCandles);

    const low =

      recentLow(todayCandles);

    const latest =

      todayCandles[

        todayCandles.length - 1

      ];

    const chartPrice =

      latest.close;

    const price =

      Number.isFinite(quotePrice)

        ? quotePrice

        : chartPrice;

    /*

     * Reject stale/mismatched chart price.

     */

    if (

      Number.isFinite(

        quotePrice

      )

    ) {

      const gap =

        Math.abs(

          chartPrice -

            quotePrice

        ) /

        quotePrice;

      if (gap > 0.03) {

        return {

          symbol,

          signal: "UNAVAILABLE",

          reason:

            "Chart price differs too much from quote",

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

          volume_confirmed: false

        };

      }

    }

    /*

     * Not enough data yet.

     */

    if (todayCandles.length < 20) {

      return {

        symbol,

        signal: "WAIT",

        reason:

          `Building 15m history (${todayCandles.length}/20 candles)`,

        price,

        quote_price: quotePrice,

        ema20:

          Number.isFinite(ema20)

            ? Number(

                ema20.toFixed(2)

              )

            : null,

        rsi14:

          Number.isFinite(rsi14)

            ? Number(

                rsi14.toFixed(2)

              )

            : null,

        vwap:

          Number.isFinite(vwap)

            ? Number(

                vwap.toFixed(2)

              )

            : null,

        relative_volume:

          Number.isFinite(

            relativeVolume

          )

            ? Number(

                relativeVolume.toFixed(2)

              )

            : null,

        trend_15m: "BUILDING",

        recent_high: high,

        recent_low: low,

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

          Number.isFinite(

            relativeVolume

          )

      };

    }

    let trend = "NEUTRAL";

    if (

      Number.isFinite(ema20)

    ) {

      if (price > ema20) {

        trend = "BULLISH";

      } else if (

        price < ema20

      ) {

        trend = "BEARISH";

      }

    }

    /*

     * Volume is mandatory for BUY/SELL.

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

        ema20:

          Number(

            ema20.toFixed(2)

          ),

        rsi14:

          Number(

            rsi14.toFixed(2)

          ),

        vwap:

          Number(

            vwap.toFixed(2)

          ),

        relative_volume: null,

        trend_15m: trend,

        recent_high: high,

        recent_low: low,

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

      Number.isFinite(high) &&

      price >= high * 0.997;

    const nearLow =

      Number.isFinite(low) &&

      price <= low * 1.003;

    const buy =

      price > ema20 &&

      price > vwap &&

      rsi14 >= 52 &&

      rsi14 <= 70 &&

      relativeVolume >= 1.2 &&

      nearHigh &&

      trend === "BULLISH";

    const sell =

      price < ema20 &&

      price < vwap &&

      rsi14 >= 30 &&

      rsi14 <= 48 &&

      relativeVolume >= 1.2 &&

      nearLow &&

      trend === "BEARISH";

    let signal = "WATCH";

    let reason =

      "Mixed conditions";

    if (buy) {

      signal = "BUY";

      reason =

        "15m bullish momentum with VWAP, EMA and volume confirmation";

    }

    if (sell) {

      signal = "SELL";

      reason =

        "15m bearish momentum with VWAP, EMA and volume confirmation";

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

        ? positionSize(

            entry,

            stopLoss,

            target1,

            target2

          )

        : positionSize(

            null,

            null,

            null,

            null

          );

    return {

      symbol,

      signal,

      reason,

      price:

        Number(price.toFixed(2)),

      quote_price:

        Number.isFinite(

          quotePrice

        )

          ? Number(

              quotePrice.toFixed(2)

            )

          : null,

      ema20:

        Number(

          ema20.toFixed(2)

        ),

      rsi14:

        Number(

          rsi14.toFixed(2)

        ),

      vwap:

        Number(

          vwap.toFixed(2)

        ),

      relative_volume:

        Number(

          relativeVolume.toFixed(2)

        ),

      trend_15m: trend,

      recent_high:

        Number(high.toFixed(2)),

      recent_low:

        Number(low.toFixed(2)),

      entry:

        entry !== null

          ? Number(

              entry.toFixed(2)

            )

          : null,

      stop_loss:

        stopLoss !== null

          ? Number(

              stopLoss.toFixed(2)

            )

          : null,

      target_1:

        target1 !== null

          ? Number(

              target1.toFixed(2)

            )

          : null,

      target_2:

        target2 !== null

          ? Number(

              target2.toFixed(2)

            )

          : null,

      capital: sizing.capital,

      quantity: sizing.quantity,

      risk: sizing.risk,

      target1_profit:

        sizing.target1_profit,

      target2_profit:

        sizing.target2_profit,

      risk_reward_1:

        sizing.risk_reward_1,

      risk_reward_2:

        sizing.risk_reward_2,

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

    "Starting 15m ₹1,000 Intraday Scanner..."

  );

  console.log(

    "India date:",

    getIndiaDate()

  );

  const results = [];

  for (const symbol of SYMBOLS) {

    console.log(

      `Scanning ${symbol}...`

    );

    results.push(

      await scanStock(symbol)

    );

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

    capital:

      CAPITAL,

    session:

      "09:15-15:15 IST",

    methodology:

      "15-minute OHLCV with live quote validation",

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

    "Written data/intraday.json"

  );

}

main().catch(error => {

  console.error(error);

  process.exit(1);

});
