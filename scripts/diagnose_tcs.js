const { NseIndia } = require("stock-nse-india");

const nse = new NseIndia();

async function main() {
  console.log("======================================");
  console.log("TCS INTRADAY API DIAGNOSTIC");
  console.log("======================================");

  try {
    const response =
      await nse.getEquityIntradayData("TCS");

    console.log("\n--- RAW RESPONSE ---\n");

    console.log(
      JSON.stringify(
        response,
        null,
        2
      )
    );

    console.log("\n--- RESPONSE KEYS ---\n");

    console.log(
      Object.keys(response || {})
    );

    console.log("\n--- grapthData TYPE ---\n");

    console.log(
      Array.isArray(response?.grapthData)
        ? "Array"
        : typeof response?.grapthData
    );

    console.log("\n--- grapthData LENGTH ---\n");

    console.log(
      Array.isArray(response?.grapthData)
        ? response.grapthData.length
        : "Not an array"
    );

    console.log("\n--- FIRST 10 grapthData ITEMS ---\n");

    if (Array.isArray(response?.grapthData)) {
      console.log(
        JSON.stringify(
          response.grapthData.slice(0, 10),
          null,
          2
        )
      );
    }

    console.log("\n--- LAST 10 grapthData ITEMS ---\n");

    if (Array.isArray(response?.grapthData)) {
      console.log(
        JSON.stringify(
          response.grapthData.slice(-10),
          null,
          2
        )
      );
    }

    console.log("\n--- CLOSE PRICE ---\n");

    console.log(
      response?.closePrice
    );

  } catch (error) {
    console.error("\nDIAGNOSTIC ERROR:\n");

    console.error(
      error?.stack || error
    );

    process.exit(1);
  }
}

main();
