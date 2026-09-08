const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

async function main() {
  console.log("======================================");
  console.log("TCS TODAY 15M CHART DIAGNOSTIC");
  console.log("Date: 2026-09-08");
  console.log("======================================");

  try {
    const range = {
      start: new Date("2026-09-08T00:00:00+05:30"),
      end: new Date("2026-09-08T23:59:59+05:30")
    };

    const response =
      await nse.getEquityChartHistoricalData(
        "TCS",
        range,
        undefined,
        "Equity",
        "I",
        "15"
      );

    console.log("\n--- RESPONSE KEYS ---\n");
    console.log(Object.keys(response || {}));

    console.log("\n--- DATA LENGTH ---\n");
    console.log(
      Array.isArray(response?.data)
        ? response.data.length
        : "Not an array"
    );

    console.log("\n--- FIRST 5 ---\n");

    if (Array.isArray(response?.data)) {
      console.log(
        JSON.stringify(
          response.data.slice(0, 5),
          null,
          2
        )
      );
    }

    console.log("\n--- LAST 5 ---\n");

    if (Array.isArray(response?.data)) {
      console.log(
        JSON.stringify(
          response.data.slice(-5),
          null,
          2
        )
      );
    }

    console.log("\n--- TIMESTAMPS AS INDIA TIME ---\n");

    if (Array.isArray(response?.data)) {
      for (const candle of response.data.slice(-10)) {
        console.log(
          new Date(candle.time).toLocaleString(
            "en-IN",
            {
              timeZone: "Asia/Kolkata"
            }
          ),
          "Close:",
          candle.close,
          "Volume:",
          candle.volume
        );
      }
    }

  } catch (error) {
    console.error("\nDIAGNOSTIC ERROR:\n");
    console.error(error?.stack || error);
    process.exit(1);
  }
}

main();
