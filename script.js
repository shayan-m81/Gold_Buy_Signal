import fs from "fs"

const TALASEA_API = "https://api.talasea.ir/api/market/getGoldPrice"
const TGJU_API = "https://call3.tgju.org/ajax.json"

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const CHAT_ID = process.env.CHAT_ID

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json"
    }
  })

  const text = await res.text()

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`)
  }

  try {
    return JSON.parse(text)
  } catch {
    console.error("Invalid JSON from:", url)
    console.error(text.slice(0, 300))
    throw new Error("Invalid JSON")
  }
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync("history.json", "utf-8"))
  } catch {
    return []
  }
}

function saveHistory(data) {
  fs.writeFileSync("history.json", JSON.stringify(data, null, 2))
}

function calculateFairPrice(usdIrr, goldOunce) {
  // 31.104 grams per troy ounce
  // 18 / 24 adjusts pure gold to 18k gold
  return (usdIrr * goldOunce / 31.104) * (18 / 24)
}

function analyze(history, marketPrice, fairPrice) {
  const diffPercent = ((fairPrice - marketPrice) / fairPrice) * 100

  if (history.length < 3) {
    return {
      buy: false,
      reason: "Not enough history",
      diffPercent
    }
  }

  const prev = history.at(-2)?.marketPrice

  if (!prev || prev <= 0) {
    return {
      buy: false,
      reason: "Invalid previous market price",
      diffPercent
    }
  }

  const dropPercent = ((prev - marketPrice) / prev) * 100

  const last5 = history.slice(-5).map(x => x.marketPrice)
  const avg5 = last5.reduce((a, b) => a + b, 0) / last5.length

  const isBelowAvg = marketPrice < avg5

  if (diffPercent >= 5 && dropPercent >= 2 && isBelowAvg) {
    return {
      buy: true,
      level: "STRONG",
      reason: "Undervalued + dip + below trend",
      diffPercent,
      dropPercent
    }
  }

  if (diffPercent >= 3) {
    return {
      buy: true,
      level: "MODERATE",
      reason: "Undervalued vs fair price",
      diffPercent,
      dropPercent
    }
  }

  return {
    buy: false,
    reason: "No buy condition met",
    diffPercent,
    dropPercent
  }
}

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or CHAT_ID")
  }

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  })

  const text = await res.text()

  if (!res.ok) {
    throw new Error(`Telegram failed: ${res.status} ${text}`)
  }
}

function parseNumber(value, label) {
  const num = Number(String(value).replace(/,/g, ""))

  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid number for ${label}: ${value}`)
  }

  return num
}

async function main() {
  try {
    const [talasea, tgju] = await Promise.all([
      fetchJSON(TALASEA_API),
      fetchJSON(TGJU_API)
    ])

    const talaseaPrice = parseNumber(talasea.price, "Talasea price")

    // Talasea price appears to be in toman, so convert to rial.
    const marketPrice = talaseaPrice * 10000

    const usdIrr = parseNumber(
      tgju.current.price_dollar_rl.p,
      "USD/IRR"
    )

    const goldOunce = parseNumber(
      tgju.current.ons.p,
      "Gold ounce"
    )

    const fairPrice = calculateFairPrice(usdIrr, goldOunce)

    const history = loadHistory()

    history.push({
      time: Date.now(),
      marketPrice,
      fairPrice
    })

    while (history.length > 100) {
      history.shift()
    }

    const result = analyze(history, marketPrice, fairPrice)

    saveHistory(history)

    if (result.buy) {
      await sendTelegram(
        `🚨 ${result.level} BUY SIGNAL\n\n` +
        `Market: ${Math.round(marketPrice).toLocaleString("en-US")}\n` +
        `Fair: ${Math.round(fairPrice).toLocaleString("en-US")}\n` +
        `Undervaluation: ${result.diffPercent.toFixed(2)}%\n` +
        `${result.dropPercent !== undefined ? `Drop: ${result.dropPercent.toFixed(2)}%\n` : ""}` +
        `\nReason: ${result.reason}`
      )
    } else {
      console.log("No signal", {
        marketPrice: Math.round(marketPrice),
        fairPrice: Math.round(fairPrice),
        diff: `${result.diffPercent.toFixed(2)}%`,
        drop: result.dropPercent !== undefined
          ? `${result.dropPercent.toFixed(2)}%`
          : null,
        reason: result.reason
      })
    }
  } catch (err) {
    console.error("Script failed:", err.message)
    process.exitCode = 1
  }
}

main()
