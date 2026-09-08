const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

async function main() {
  const response =
    await nse.getEquityChartHistoricalData(
      "TCS",
      undefined,
      undefined,
      "Equity",
      "I",
      "15"
    );

  console.log("15M DATA LENGTH:");
  console.log(response?.data?.length);

  console.log("\nALL 15M CANDLE TIMES:");

  for (const candle of response?.data || []) {
    console.log(
      new Date(Number(candle.time)).toISOString(),
      "O:",
      candle.open,
      "H:",
      candle.high,
      "L:",
      candle.low,
      "C:",
      candle.close,
      "V:",
      candle.volume
    );
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
