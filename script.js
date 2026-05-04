import fs from "fs"

const TALASEA_API = "https://api.talasea.ir/api/market/getGoldPrice"
const TGJU_API = "https://call3.tgju.org/ajax.json"

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const CHAT_ID = process.env.CHAT_ID

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  })

  const text = await res.text()

  try {
    return JSON.parse(text)
  } catch {
    console.error("❌ Invalid JSON from:", url)
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
  return (usdIrr * goldOunce / 31.104) * (18 / 24)
}

function analyze(history, marketPrice, fairPrice) {
  const diffPercent = ((fairPrice - marketPrice) / fairPrice) * 100

  if (history.length < 3) return { buy: false }

  const prev = history.at(-2).marketPrice
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
      diffPercent
    }
  }

  return { buy: false, diffPercent }
}

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  })
}

async function main() {
  try {
    const [talasea, tgju] = await Promise.all([
      fetchJSON(TALASEA_API),
      fetchJSON(TGJU_API)
    ])

    // 🟡 Market price (Talasea)
    let marketPrice = Number(talasea.price) * 10

    // 🔵 USD + Ounce (TGJU)
    const usdIrr = Number(
      tgju.current.price_dollar_rl.p.replace(/,/g, "")
    )

    const goldOunce = Number(
      tgju.current.ons.p.replace(/,/g, "")
    )

    const fairPrice = calculateFairPrice(usdIrr, goldOunce)

    let history = loadHistory()

    history.push({
      time: Date.now(),
      marketPrice,
      fairPrice
    })

    if (history.length > 100) history.shift()

    const result = analyze(history, marketPrice, fairPrice)

    saveHistory(history)

    if (result.buy) {
      await sendTelegram(
        `🚨 ${result.level} BUY SIGNAL\n\n` +
        `Market: ${marketPrice}\n` +
        `Fair: ${Math.round(fairPrice)}\n` +
        `Undervaluation: ${result.diffPercent.toFixed(2)}%\n` +
        `${result.dropPercent ? `Drop: ${result.dropPercent.toFixed(2)}%\n` : ""}` +
        `\nReason: ${result.reason}`
      )
    } else {
      console.log("No signal", {
        marketPrice,
        fairPrice,
        diff: result.diffPercent
      })
    }

  } catch (err) {
    console.error("🔥 Script failed:", err.message)
  }
}

main()
