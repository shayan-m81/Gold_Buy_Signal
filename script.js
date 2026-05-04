import fs from "fs"

const TALASEA_API = "https://api.talasea.ir/api/market/getGoldPrice"
const TGJU_ONS_URL = "https://www.tgju.org/profile/ons"
const TGJU_USD_URL = "https://www.tgju.org/profile/price_dollar_rl"

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const CHAT_ID = process.env.CHAT_ID

async function fetchText(url) {
  const finalUrl = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`

  const res = await fetch(finalUrl, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache, no-store, max-age=0",
      "Pragma": "no-cache",
      "Referer": "https://www.tgju.org/"
    }
  })

  const text = await res.text()

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${finalUrl}: ${text.slice(0, 300)}`)
  }

  return text
}

async function fetchJSON(url) {
  const text = await fetchText(url)

  try {
    return JSON.parse(text)
  } catch {
    console.error("Invalid JSON from:", url)
    console.error(text.slice(0, 300))
    throw new Error("Invalid JSON")
  }
}

function parseNumber(value, label) {
  const normalized = String(value)
    .replace(/,/g, "")
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .trim()

  const num = Number(normalized)

  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid number for ${label}: ${value}`)
  }

  return num
}

function extractTgjuProfilePrice(html, label) {
  const regex = /<span[^>]*data-col=["']info\.last_trade\.PDrCotVal["'][^>]*>\s*([^<]+?)\s*<\/span>/i
  const match = html.match(regex)

  if (!match) {
    console.error(`${label} HTML preview:`, html.slice(0, 500))
    throw new Error(`Could not extract ${label} price from TGJU profile page`)
  }

  return parseNumber(match[1], label)
}

async function fetchTGJUProfilePrices() {
  const [onsHtml, usdHtml] = await Promise.all([
    fetchText(TGJU_ONS_URL),
    fetchText(TGJU_USD_URL)
  ])

  const goldOunce = extractTgjuProfilePrice(onsHtml, "Gold ounce")
  const usdIrr = extractTgjuProfilePrice(usdHtml, "USD/IRR")

  return {
    goldOunce,
    usdIrr
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

async function main() {
  try {
    const [talasea, tgjuPrices] = await Promise.all([
      fetchJSON(TALASEA_API),
      fetchTGJUProfilePrices()
    ])

    const talaseaPrice = parseNumber(talasea.price, "Talasea price")

    const marketPrice = talaseaPrice * 10000
    const usdIrr = tgjuPrices.usdIrr
    const goldOunce = tgjuPrices.goldOunce

    const fairPrice = calculateFairPrice(usdIrr, goldOunce)

    console.log("Price debug", {
      marketPrice: Math.round(marketPrice),
      usdIrr,
      goldOunce,
      fairPrice: Math.round(fairPrice)
    })

    const history = loadHistory()

    history.push({
      time: Date.now(),
      marketPrice,
      fairPrice,
      usdIrr,
      goldOunce
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
        `USD/IRR: ${Math.round(usdIrr).toLocaleString("en-US")}\n` +
        `Ounce: ${goldOunce.toLocaleString("en-US")}\n` +
        `Undervaluation: ${result.diffPercent.toFixed(2)}%\n` +
        `${result.dropPercent !== undefined ? `Drop: ${result.dropPercent.toFixed(2)}%\n` : ""}` +
        `\nReason: ${result.reason}`
      )
    } else {
      console.log("No signal", {
      marketPrice,
      fairPrice,
      usdIrr,
      goldOunce,
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
