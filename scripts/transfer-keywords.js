// ============================================================================
// Transfer keywords — the ONE source both recurring detectors read (cycle-9 F20)
// ============================================================================
// scripts/detect-transfers.js takes a row when classifyTransferTxn says it is a
// transfer; scripts/detect-subscriptions.js leaves the same rows out. The two
// used to keep separate lists (the subscription exclusions lacked "mortgage
// payment", "bill pay", the savings and brokerage names, …), so a steady
// mortgage payment, brokerage contribution or savings transfer was detected as
// BOTH a subscription and a recurring transfer — billed twice by the cash-flow
// forecast and counted in the subscription totals.
//
// Transfer types:
//   - peer_transfer: Zelle, Venmo, Cash App, PayPal
//   - bill_payment: credit card, loan, mortgage, autopay
//   - savings: savings account, emergency fund transfers
//   - investment: brokerage, 401k, IRA contributions
//   - internal: between own accounts (ACH, wire, internal)
// ============================================================================

const TRANSFER_PATTERNS = {
  peer_transfer: [
    "zelle", "venmo", "cash app", "cashapp", "square cash", "paypal",
  ],
  bill_payment: [
    "directpay", "minimum payment", "autopay", "auto pay", "payment thank",
    "credit card payment", "loan payment", "debt payment", "mortgage payment",
    "bill pay", "epay", "automatic payment",
  ],
  savings: [
    "savings", "emergency fund", "rainy day",
  ],
  investment: [
    "vanguard", "fidelity", "schwab", "etrade", "e*trade", "robinhood",
    "betterment", "wealthfront", "acorns", "401k", "ira contribution",
    "brokerage",
  ],
  internal: [
    "funds tran", "funds transfer", "transfer to", "transfer from",
    "ach transfer", "wire transfer", "internal transfer",
    "online transfer", "mobile transfer",
    "boa transfer",
  ],
};

function classifyTransfer(merchantKey) {
  if (!merchantKey) return null;
  const lower = merchantKey.toLowerCase();
  for (const [type, keywords] of Object.entries(TRANSFER_PATTERNS)) {
    if (keywords.some(kw => {
      // Mirror detect-subscriptions.js isExcludedMerchant: multi-word keywords
      // are safe as substrings, but single-word keywords MUST use a word
      // boundary so short tokens like "ira"/"epay" don't substring-match
      // unrelated merchants ("Mira", "telepayments") and mis-tag ordinary
      // purchases as recurring transfers (which would also hide them from
      // spending via the parallel NOT_TRANSFER filter). (F32)
      if (kw.includes(" ")) return lower.includes(kw);
      const re = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      return re.test(lower);
    })) return type;
  }
  return null;
}

function isTransferMerchant(merchantKey) {
  return classifyTransfer(merchantKey) !== null;
}

// F49: a raw bank description is matched only against the PHRASE-like types —
// peer apps (except PayPal, which also prefixes ordinary purchases: "PAYPAL
// *NETFLIX"), bill payments and internal transfers. Brand words (Vanguard,
// Schwab, "savings") stay merchant-only, like NOT_TRANSFER's brand list (F32).
const RAW_DESCRIPTION_TYPES = ["peer_transfer", "bill_payment", "internal"];
const RAW_DESCRIPTION_SKIP = new Set(["paypal"]);
function classifyTransferDescription(description) {
  if (!description) return null;
  const lower = String(description).toLowerCase();
  for (const type of RAW_DESCRIPTION_TYPES) {
    if (TRANSFER_PATTERNS[type].some((kw) => {
      if (RAW_DESCRIPTION_SKIP.has(kw)) return false;
      if (kw.includes(" ")) return lower.includes(kw);
      const re = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      return re.test(lower);
    })) return type;
  }
  return null;
}

// The type a transaction reads as: its merchant key first, then (F49) its raw
// description — "ZELLE TO JOHN SMITH" with counterparty "John Smith" is a
// peer transfer even though the key is just a name.
function classifyTransferTxn(merchantKey, rawDescription) {
  return classifyTransfer(merchantKey) || classifyTransferDescription(rawDescription);
}

module.exports = { TRANSFER_PATTERNS, classifyTransfer, classifyTransferDescription, classifyTransferTxn, isTransferMerchant };
