import json
import os
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

API_KEY = os.environ.get("TWELVE_DATA_API_KEY")

if not API_KEY:
    raise SystemExit("TWELVE_DATA_API_KEY is missing.")

with open(DATA / "universe.json", "r") as f:
    universe = json.load(f)

symbols = universe["symbols"]


def get_data(url):
    request = Request(
        url,
        headers={
            "User-Agent": "1KRS-stock-finder/1.0"
        }
    )

    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def calculate_score(stats):
    valuation = stats.get("valuations_metrics", {})
    financials = stats.get("financials", {})
    cashflow = stats.get("cash_flow", {})

    score = 0
    possible = 0

    roe = number(financials.get("return_on_equity_ttm"))

    if roe is not None:
        possible += 15
        if roe >= 0.15:
            score += 15

    ocf = number(cashflow.get("operating_cash_flow_ttm"))

    if ocf is not None:
        possible += 10
        if ocf > 0:
            score += 10

    fcf = number(cashflow.get("levered_free_cash_flow_ttm"))

    if fcf is not None:
        possible += 10
        if fcf > 0:
            score += 10

    pe = number(valuation.get("trailing_pe"))

    if pe is not None:
        possible += 15
        if 0 < pe <= 25:
            score += 15

    peg = number(valuation.get("peg_ratio"))

    if peg is not None:
        possible += 10
        if peg <= 1.5:
            score += 10

    margin = number(financials.get("profit_margin"))

    if margin is not None:
        possible += 10
        if margin > 0:
            score += 10

    if possible < 40:
        return None

    return round(score / possible * 100, 1)


stocks = []

for symbol in symbols:

    price_url = (
        "https://api.twelvedata.com/price"
        "?symbol=" + quote(symbol + ":NSE")
        + "&apikey=" + quote(API_KEY)
    )

    stats_url = (
        "https://api.twelvedata.com/statistics"
        "?symbol=" + quote(symbol + ":NSE")
        + "&apikey=" + quote(API_KEY)
    )

    price_data = get_data(price_url)
    stats_data = get_data(stats_url)

    if price_data.get("status") == "error":
        raise RuntimeError(
            f"{symbol}: price request failed"
        )

    if stats_data.get("status") == "error":
        raise RuntimeError(
            f"{symbol}: statistics request failed"
        )

    price = number(price_data.get("price"))

    if price is None:
        raise RuntimeError(
            f"{symbol}: invalid price"
        )

    valuation = stats_data.get(
        "valuations_metrics", {}
    )

    financials = stats_data.get(
        "financials", {}
    )

    cashflow = stats_data.get(
        "cash_flow", {}
    )

    pe = number(
        valuation.get("trailing_pe")
    )

    eps = None
    fair_value = None
    upside = None

    if pe and pe > 0:
        eps = price / pe
        fair_value = eps * 20
        upside = fair_value / price - 1

    roe = number(
        financials.get(
            "return_on_equity_ttm"
        )
    )

    margin = number(
        financials.get(
            "profit_margin"
        )
    )

    market_cap = number(
        valuation.get(
            "market_capitalization"
        )
    )

    score = calculate_score(
        stats_data
    )

    if score is None:
        tag = "watch"
    elif upside is not None and score >= 75 and upside >= 0.15:
        tag = "undervalued"
    elif score >= 75:
        tag = "growth"
    elif score >= 55:
        tag = "watch"
    else:
        tag = "trap"

    stocks.append({
        "symbol": symbol,
        "name": symbol,
        "price": price,

        "score": score,

        "pe": pe,
        "peg": number(
            valuation.get("peg_ratio")
        ),

        "roe": (
            roe * 100
            if roe is not None
            else None
        ),

        "roce": None,
        "de": None,
        "growth5": None,

        "profitMargin": (
            margin * 100
            if margin is not None
            else None
        ),

        "marketCapCr": (
            market_cap / 10000000
            if market_cap is not None
            else None
        ),

        "operatingCashFlow": number(
            cashflow.get(
                "operating_cash_flow_ttm"
            )
        ),

        "freeCashFlow": number(
            cashflow.get(
                "levered_free_cash_flow_ttm"
            )
        ),

        "insiderPct": number(
            stats_data.get(
                "stock_statistics",
                {}
            ).get(
                "percent_held_by_insiders"
            )
        ),

        "eps": eps,
        "fairValue": fair_value,
        "upside": upside,

        "tag": tag,

        "source": "Twelve Data"
    })


output = {
    "updated_at": datetime.now(
        timezone.utc
    ).isoformat(),

    "currency": "INR",

    "provider": {
        "name": "Twelve Data",
        "exchange": "NSE",
        "mic_code": "XNSE"
    },

    "stocks": stocks
}


output_file = DATA / "stocks.json"

fd, temp_file = tempfile.mkstemp(
    prefix="stocks-",
    suffix=".json",
    dir=DATA
)

os.close(fd)

with open(temp_file, "w") as f:
    json.dump(
        output,
        f,
        indent=2
    )

os.replace(
    temp_file,
    output_file
)

print(
    f"Updated {len(stocks)} stocks."
)
