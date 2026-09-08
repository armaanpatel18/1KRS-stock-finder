const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

async function main() {
  console.log("======================================");
  console.log("TCS CHART DATA DIAGNOSTIC");
  console.log("======================================");

  try {
    const response =
      await nse.getEquityChartHistoricalData(
        "TCS",
        undefined,
        undefined,
        "Equity",
        "I",
        "5"
      );

    console.log("\n--- RESPONSE TYPE ---\n");
    console.log(typeof response);

    console.log("\n--- RESPONSE KEYS ---\n");
    console.log(Object.keys(response || {}));

    console.log("\n--- RAW RESPONSE ---\n");
    console.log(JSON.stringify(response, null, 2));

    console.log("\n--- DATA TYPE ---\n");
    console.log(
      Array.isArray(response?.data)
        ? "Array"
        : typeof response?.data
    );

    console.log("\n--- DATA LENGTH ---\n");
    console.log(
      Array.isArray(response?.data)
        ? response.data.length
        : "Not an array"
    );

    console.log("\n--- FIRST 5 DATA ITEMS ---\n");

    if (Array.isArray(response?.data)) {
      console.log(
        JSON.stringify(
          response.data.slice(0, 5),
          null,
          2
        )
      );
    }

    console.log("\n--- LAST 5 DATA ITEMS ---\n");

    if (Array.isArray(response?.data)) {
      console.log(
        JSON.stringify(
          response.data.slice(-5),
          null,
          2
        )
      );
    }

  } catch (error) {
    console.error("\nDIAGNOSTIC ERROR:\n");
    console.error(error?.stack || error);

    process.exit(1);
  }
}

main();
