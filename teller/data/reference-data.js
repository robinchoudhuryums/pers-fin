// ============================================================================
// Reference Data — Static lookup tables for insights and categorization
// ============================================================================

// Average residential electricity rates by state (cents/kWh, EIA 2025 data)
const STATE_ELECTRICITY_RATES = {
  AL: 15.88, AK: 27.70, AZ: 15.20, AR: 13.30, CA: 32.58, CO: 16.50,
  CT: 30.30, DE: 16.80, DC: 23.20, FL: 15.12, GA: 15.50, HI: 42.62,
  ID: 11.74, IL: 18.10, IN: 16.60, IA: 15.60, KS: 14.70, KY: 13.80,
  LA: 12.44, ME: 29.55, MD: 17.40, MA: 31.51, MI: 19.50, MN: 15.20,
  MS: 13.90, MO: 13.60, MT: 12.90, NE: 12.80, NV: 14.80, NH: 25.90,
  NJ: 19.80, NM: 15.50, NY: 24.30, NC: 14.50, ND: 11.02, OH: 15.60,
  OK: 12.80, OR: 13.20, PA: 18.50, RI: 31.30, SC: 14.80, SD: 13.90,
  TN: 13.40, TX: 15.87, UT: 12.30, VT: 22.80, VA: 15.10, WA: 12.00,
  WV: 13.80, WI: 17.30, WY: 12.50,
};
const US_AVG_ELECTRICITY_RATE = 18.05; // national average cents/kWh

// ZIP code prefix → state mapping (first 3 digits)
const ZIP_TO_STATE = {};
const zipRanges = [
  [[35,36],"AL"],[[995,999],"AK"],[[850,865],"AZ"],[[716,729],"AR"],
  [[900,961],"CA"],[[800,816],"CO"],[[60,69],"CT"],[[197,199],"DE"],
  [[200,205],"DC"],[[320,349],"FL"],[[300,319],"GA"],[[967,968],"HI"],
  [[832,838],"ID"],[[600,629],"IL"],[[460,479],"IN"],[[500,528],"IA"],
  [[660,679],"KS"],[[400,427],"KY"],[[700,714],"LA"],[[39,49],"ME"],
  [[206,219],"MD"],[[10,27],"MA"],[[480,499],"MI"],[[550,567],"MN"],
  [[386,397],"MS"],[[630,658],"MO"],[[590,599],"MT"],[[680,693],"NE"],
  [[889,898],"NV"],[[30,38],"NH"],[[70,89],"NJ"],[[870,884],"NM"],
  [[100,149],"NY"],[[270,289],"NC"],[[580,588],"ND"],[[430,459],"OH"],
  [[730,749],"OK"],[[970,979],"OR"],[[150,196],"PA"],[[28,29],"RI"],
  [[290,299],"SC"],[[570,577],"SD"],[[370,385],"TN"],[[750,799],"TX"],
  [[840,847],"UT"],[[50,59],"VT"],[[220,246],"VA"],[[980,994],"WA"],
  [[247,268],"WV"],[[530,549],"WI"],[[820,831],"WY"],
];
for (const [ranges, state] of zipRanges) {
  for (let z = ranges[0]; z <= ranges[1]; z++) {
    ZIP_TO_STATE[z] = state;
  }
}

function zipToState(zip) {
  if (!zip || zip.length < 3) return null;
  const prefix = parseInt(zip.substring(0, 3));
  return ZIP_TO_STATE[prefix] || null;
}

// BLS Consumer Expenditure Survey averages (annual, 2024 data)
const ANNUAL_SPENDING_BENCHMARKS = {
  housing: { avg: 24298, label: "Housing (rent/mortgage, maintenance)" },
  transportation: { avg: 12295, label: "Transportation (car, gas, insurance, transit)" },
  food: { avg: 9854, label: "Food (groceries + dining out)" },
  healthcare: { avg: 5850, label: "Healthcare (insurance + out-of-pocket)" },
  entertainment: { avg: 3458, label: "Entertainment & recreation" },
  utilities: { avg: 4968, label: "Utilities (electric, gas, water, internet, phone)" },
  insurance: { avg: 7010, label: "Insurance (all types)" },
  clothing: { avg: 1945, label: "Apparel & services" },
  subscriptions_streaming: { avg: 780, label: "Streaming & digital subscriptions" },
};

// Cancel URLs for popular subscription services
const CANCEL_URLS = {
  "netflix": "https://www.netflix.com/cancelplan",
  "spotify": "https://www.spotify.com/account/subscription/",
  "hulu": "https://secure.hulu.com/account",
  "disney+": "https://www.disneyplus.com/account",
  "disney plus": "https://www.disneyplus.com/account",
  "hbo max": "https://www.max.com/account",
  "hbo": "https://www.max.com/account",
  "max": "https://www.max.com/account",
  "amazon prime": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "prime video": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "apple": "https://support.apple.com/en-us/HT202039",
  "icloud": "https://support.apple.com/en-us/HT202039",
  "youtube": "https://www.youtube.com/paid_memberships",
  "google one": "https://one.google.com/settings",
  "adobe": "https://account.adobe.com/plans",
  "microsoft": "https://account.microsoft.com/services/",
  "xbox": "https://account.microsoft.com/services/",
  "playstation": "https://store.playstation.com/subscriptions",
  "dropbox": "https://www.dropbox.com/account/plan",
  "chatgpt": "https://chat.openai.com/settings/subscription",
  "openai": "https://chat.openai.com/settings/subscription",
  "slack": "https://slack.com/account/settings",
  "zoom": "https://zoom.us/account",
  "nordvpn": "https://my.nordaccount.com/dashboard/nordvpn/",
  "expressvpn": "https://www.expressvpn.com/subscriptions",
  "paramount+": "https://www.paramountplus.com/account/",
  "paramount plus": "https://www.paramountplus.com/account/",
  "peacock": "https://www.peacocktv.com/account/subscription",
  "crunchyroll": "https://www.crunchyroll.com/account/subscription",
  "audible": "https://www.audible.com/account/prefs",
  "kindle unlimited": "https://www.amazon.com/kindle-dbs/hz/subscribe/ku",
  "nytimes": "https://myaccount.nytimes.com/seg/subscription",
  "new york times": "https://myaccount.nytimes.com/seg/subscription",
  "wall street journal": "https://customercenter.wsj.com/",
  "wsj": "https://customercenter.wsj.com/",
  "linkedin premium": "https://www.linkedin.com/mypreferences/d/manage-subscription",
  "grammarly": "https://account.grammarly.com/subscription",
  "dashlane": "https://app.dashlane.com/account/subscriptions",
  "1password": "https://my.1password.com/settings/billing",
  "github": "https://github.com/settings/billing",
  "notion": "https://www.notion.so/my-account",
  "figma": "https://www.figma.com/settings",
  "canva": "https://www.canva.com/settings/billing-and-plans",
};

// Subscription category auto-tagging
const CATEGORY_RULES = {
  utility: ["electric", "power", "energy", "gas", "water", "sewer", "sewage", "trash", "waste", "garbage", "recycling",
    "internet", "broadband", "comcast", "xfinity", "spectrum", "att", "at&t", "verizon", "t-mobile", "tmobile",
    "cox", "centurylink", "lumen", "frontier", "windstream", "optimum", "mediacom",
    "direct energy", "duke energy", "dominion", "pge", "pg&e", "pacific gas", "con edison", "coned", "entergy", "eversource",
    "national grid", "southern company", "sce", "socal edison", "fpl", "florida power",
    "pepco", "bge", "peco", "pseg", "ameren", "xcel", "avista", "puget sound",
    "consumers energy", "dte", "aep", "rocky mountain", "nstar", "green mountain",
    "city of", "municipal", "utility", "utilities"],
  streaming: ["netflix", "hulu", "disney", "hbo", "max", "prime video", "peacock", "paramount", "crunchyroll", "apple tv", "youtube premium", "spotify", "tidal", "deezer", "pandora", "audible"],
  software: ["adobe", "microsoft", "notion", "figma", "canva", "github", "slack", "zoom", "dropbox", "1password", "dashlane", "grammarly", "chatgpt", "openai", "jetbrains"],
  gaming: ["xbox", "playstation", "ps plus", "nintendo", "steam", "ea play", "game pass"],
  news: ["nytimes", "new york times", "wsj", "wall street journal", "washington post", "the athletic", "substack"],
  fitness: ["peloton", "strava", "fitbit", "headspace", "calm", "noom", "orange theory", "planet fitness", "gym"],
  cloud: ["icloud", "google one", "aws", "azure", "digitalocean", "backblaze"],
  vpn: ["nordvpn", "expressvpn", "surfshark", "protonvpn", "private internet"],
  shopping: ["amazon prime", "costco", "walmart", "instacart", "doordash", "uber eats", "grubhub"],
  finance: ["mint", "ynab", "quickbooks", "turbotax", "credit karma"],
  communication: ["linkedin", "bumble", "tinder", "match", "whatsapp", "skype"],
  insurance: ["geico", "progressive", "state farm", "allstate", "usaa", "liberty mutual", "farmers", "nationwide", "travelers"],
};

function categorizeSubscription(merchantName) {
  if (!merchantName) return "other";
  const lower = merchantName.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_RULES)) {
    if (keywords.some(kw => {
      // Multi-word keywords: use simple includes (e.g. "apple tv", "planet fitness")
      if (kw.includes(" ")) return lower.includes(kw);
      // Single-word keywords: match word boundaries to avoid partial matches
      // (e.g. "visa" shouldn't match "supervision")
      const re = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      return re.test(lower);
    })) return category;
  }
  return "other";
}

function findCancelUrl(merchantName) {
  if (!merchantName) return null;
  const lower = merchantName.toLowerCase();
  for (const [key, url] of Object.entries(CANCEL_URLS)) {
    // Use word boundary matching to avoid partial matches
    if (key.includes(" ")) {
      if (lower.includes(key)) return url;
    } else {
      const re = new RegExp("\\b" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (re.test(lower)) return url;
    }
  }
  return null;
}

// AI model cost tracking
// Cached input tokens are 90% cheaper than regular input tokens
const MODEL_COST_PER_M = {
  haiku:  { input: 0.80, output: 4.00, cache_read: 0.08, cache_write: 1.00, blended: 2.00 },
  sonnet: { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75, blended: 8.00 },
  opus:   { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75, blended: 40.00 },
};

function modelFamily(modelStr) {
  if (!modelStr) return "sonnet";
  const m = modelStr.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}

function estimateCostUsd(tokens, modelStr) {
  const family = modelFamily(modelStr);
  return (tokens / 1_000_000) * (MODEL_COST_PER_M[family]?.blended || 8);
}

// Granular cost calculation using separate input/output/cached token counts.
// Per Anthropic's API, `usage.input_tokens` reports ONLY the non-cached input —
// cache reads and cache creations are billed separately via their own counters.
// Earlier versions of this function subtracted them again, which collapsed the
// regular-input portion to ~0 on cached requests and silently understated cost
// (and therefore failed to enforce INSIGHTS_MONTHLY_BUDGET_CENTS).
function estimateCostGranular(usage, modelStr) {
  const family = modelFamily(modelStr);
  const rates = MODEL_COST_PER_M[family] || MODEL_COST_PER_M.sonnet;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  return (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output +
    (cacheRead / 1_000_000) * rates.cache_read +
    (cacheCreation / 1_000_000) * rates.cache_write;
}

// Insight modules — each adds context to the AI prompt
const INSIGHT_MODULES = {
  utility_comparison: {
    label: "Utility rate comparison",
    description: "Compare your utility bills to state/regional averages",
    extra_tokens: 150,
    requires_zip: true,
  },
  spending_benchmarks: {
    label: "Spending benchmarks",
    description: "Compare your spending to national household averages",
    extra_tokens: 200,
    requires_zip: false,
  },
  savings_suggestions: {
    label: "Savings & wealth-building",
    description: "Actionable tips for reducing spend and building wealth",
    extra_tokens: 120,
    requires_zip: false,
  },
  subscription_audit: {
    label: "Subscription audit",
    description: "Flag redundant, unused, or overpriced subscriptions",
    extra_tokens: 100,
    requires_zip: false,
  },
  anomaly_detection: {
    label: "Anomaly detection",
    description: "Flag unusual transactions that deviate from your typical spending",
    extra_tokens: 250,
    requires_zip: false,
  },
  seasonal_forecast: {
    label: "Seasonal forecasting",
    description: "Predict upcoming spend based on seasonal patterns in your history",
    extra_tokens: 200,
    requires_zip: false,
  },
  debt_optimizer: {
    label: "Debt payoff optimizer",
    description: "Credit card payoff strategies with utilization and credit score impact",
    extra_tokens: 300,
    requires_zip: false,
  },
  bill_negotiation: {
    label: "Bill negotiation tips",
    description: "Identify bills where calling to negotiate typically saves 10-30%",
    extra_tokens: 100,
    requires_zip: false,
  },
  income_savings: {
    label: "Income & savings rate",
    description: "Track income deposits and calculate your savings rate",
    extra_tokens: 150,
    requires_zip: false,
  },
  tax_deductions: {
    label: "Tax deduction flags",
    description: "Flag potentially tax-deductible transactions",
    extra_tokens: 150,
    requires_zip: false,
  },
  goal_tracking: {
    label: "Goal progress",
    description: "Track progress toward your financial goals with projections",
    extra_tokens: 200,
    requires_zip: false,
  },
  recurring_transfers: {
    label: "Recurring transfers",
    description: "Analyze recurring transfers (Zelle, bill payments, savings, investments)",
    extra_tokens: 150,
    requires_zip: false,
  },
};

// Model ID mapping for Claude API
const MODEL_MAP = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-5", opus: "claude-opus-4-6" };

module.exports = {
  STATE_ELECTRICITY_RATES,
  US_AVG_ELECTRICITY_RATE,
  ZIP_TO_STATE,
  zipToState,
  ANNUAL_SPENDING_BENCHMARKS,
  CANCEL_URLS,
  CATEGORY_RULES,
  categorizeSubscription,
  findCancelUrl,
  MODEL_COST_PER_M,
  modelFamily,
  estimateCostUsd,
  estimateCostGranular,
  INSIGHT_MODULES,
  MODEL_MAP,
};
