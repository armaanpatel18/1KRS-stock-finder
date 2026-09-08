const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

async function test(name, fn) {
  console.log("\n======================================");
  console.log(name);
  console.log("======================================");

  try {
    const result = await fn();

    console.log("SUCCESS");

    if (result && typeof result === "object") {
      console.log("Keys:", Object.keys(result));

      if (Array.isArray(result.data)) {
        console.log("data.length:", result.data.length);
      }

      if (result.priceInfo) {
        console.log(
          "priceInfo:",
          JSON.stringify(result.priceInfo, null, 2)
        );
      }

      console.log(
        "Sample:",
        JSON.stringify(
          Array.isArray(result.data)
            ? result.data.slice(-2)
            : result,
          null,
          2
        )
      );
    } else {
      console.log(result);
    }

    return result;
  } catch (error) {
    console.log("FAILED");

    console.log(
      "Message:",
      error?.message || "No message"
    );

    console.log(
      "Stack:",
      error?.stack || "No stack"
    );

    console.log(
      "Full error:",
      JSON.stringify(error, null, 2)
    );

    return null;
  }
}

async function main() {
  console.log("======================================");
  console.log("TCS FULL INTRADAY DIAGNOSTIC");
  console.log("======================================");

  await test(
    "1. TCS 5-MINUTE CHART",
    async () => {
      return await nse.getEquityChartHistoricalData(
        "TCS",
        undefined,
        undefined,
        "Equity",
        "I",
        "5"
      );
    }
  );

  await test(
    "2. TCS 15-MINUTE CHART",
    async () => {
      return await nse.getEquityChartHistoricalData(
        "TCS",
        undefined,
        undefined,
        "Equity",
        "I",
        "15"
      );
    }
  );

  await test(
    "3. TCS EQUITY DETAILS",
    async () => {
      return await nse.getEquityDetails("TCS");
    }
  );
}

main();
