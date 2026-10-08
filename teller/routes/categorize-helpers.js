// ============================================================================
// Categorization helpers — constants + Teller→ours mapping
// ============================================================================
// Extracted from categorize.js to keep the route file small. Anything the
// categorize route needs that's mostly data lives here.

// Standard categories for classification. The categorize route and manual
// edit endpoints validate user input against this list.
const CATEGORIES = [
  "Food & Drink", "Groceries", "Transportation", "Gas & Fuel",
  "Shopping", "Entertainment", "Health & Fitness", "Healthcare",
  "Housing", "Utilities", "Insurance", "Education",
  "Travel", "Personal Care", "Gifts & Donations", "Fees & Charges",
  "Transfer", "Income", "Investment", "Subscription",
  "Other",
];

// Rich descriptions the AI sees when classifying. Boundary cases (Food &
// Drink vs Groceries, Transfer vs Income, Subscription vs Entertainment)
// are the ones Haiku most often gets wrong without guidance.
const CATEGORY_DESCRIPTIONS = [
  "Food & Drink: restaurants, cafes, bars, coffee shops, food delivery (DoorDash, Uber Eats, Starbucks, Chipotle)",
  "Groceries: supermarkets and grocery stores only (Whole Foods, Trader Joe's, Kroger, Safeway, Costco grocery)",
  "Transportation: rideshare, public transit, parking, tolls, car service (Uber, Lyft, MTA, tolls)",
  "Gas & Fuel: gas stations only (Shell, Chevron, Exxon, BP, 76)",
  "Shopping: general retail, clothing, electronics, Amazon, department stores, home goods",
  "Entertainment: streaming video/music, movies, concerts, games, books (Netflix, Spotify, AMC, Steam) — but software SaaS goes to Subscription",
  "Health & Fitness: gyms, yoga, sports equipment, supplements, fitness apps",
  "Healthcare: doctors, dentists, pharmacy, hospitals, medical copays, health insurance claims",
  "Housing: rent, mortgage, HOA dues, property tax, home repair",
  "Utilities: electric, gas, water, internet, cell phone, trash, cable",
  "Insurance: auto/home/life insurance premiums (medical copays go to Healthcare)",
  "Education: tuition, books, courses, schools, certifications",
  "Travel: airlines, hotels, rental cars, vacation packages, Airbnb",
  "Personal Care: salon, barber, spa, cosmetics, grooming",
  "Gifts & Donations: charity (Goodwill, Red Cross), gifts for others",
  "Fees & Charges: bank fees, ATM fees, late fees, interest charges, overdraft",
  "Transfer: P2P transfers (Venmo, Zelle, Cash App, PayPal to friends), internal bank transfers between own accounts — NOT paychecks",
  "Income: paychecks, direct deposit, dividends, interest earned, refunds, tax returns",
  "Investment: brokerage contributions, 401k, IRA, stock/ETF purchases, robo-advisor",
  "Subscription: software, SaaS, cloud storage, professional memberships with recurring charges (Dropbox, GitHub, LinkedIn Premium)",
  "Other: only when no category above clearly fits",
].join("\n");

// Teller returns its own category taxonomy (lower-case, granular) in
// transaction.details.category. When it hands us one of these we can map
// it directly into our scheme without spending an AI call. Only the
// ambiguous buckets (general/service/office/advertising) fall through to
// the AI classifier.
const TELLER_CATEGORY_MAP = {
  dining: "Food & Drink",
  bar: "Food & Drink",
  groceries: "Groceries",
  transportation: "Transportation",
  transport: "Transportation",
  fuel: "Gas & Fuel",
  gas: "Gas & Fuel",
  shopping: "Shopping",
  clothing: "Shopping",
  electronics: "Shopping",
  entertainment: "Entertainment",
  sport: "Health & Fitness",
  health: "Healthcare",
  home: "Housing",
  // Teller's "accommodation" is LODGING (hotels) — a $600 Marriott stay was
  // auto-filed under Housing, inflating Housing budgets and the AI's housing
  // benchmark (DC-12).
  accommodation: "Travel",
  utilities: "Utilities",
  phone: "Utilities",
  insurance: "Insurance",
  education: "Education",
  travel: "Travel",
  charity: "Gifts & Donations",
  income: "Income",
  investment: "Investment",
  // Loan payments move money to a lender — a Transfer, not a fee (DC-12).
  loan: "Transfer",
  tax: "Fees & Charges",
  software: "Subscription",
};

// Plaid's personal_finance_category (PFC) → our scheme (DD-3). Plaid stores the
// current taxonomy in transactions.personal_finance_category ({primary,
// detailed}); the legacy `category` array is deprecated and has no top-level
// Income. Mapping it is free, so it runs before paid AI. DETAILED codes win
// over the PRIMARY code (e.g. FOOD_AND_DRINK_GROCERIES → Groceries while the
// rest of FOOD_AND_DRINK → Food & Drink). Ambiguous primaries
// (GENERAL_SERVICES, GOVERNMENT_AND_NON_PROFIT) are left to rules/AI except for
// their unambiguous detailed codes.
const PLAID_PFC_DETAILED_MAP = {
  FOOD_AND_DRINK_GROCERIES: "Groceries",
  TRANSPORTATION_GAS: "Gas & Fuel",
  RENT_AND_UTILITIES_RENT: "Housing",
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "Health & Fitness",
  GENERAL_SERVICES_INSURANCE: "Insurance",
  GENERAL_SERVICES_EDUCATION: "Education",
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: "Gifts & Donations",
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: "Fees & Charges",
};
const PLAID_PFC_PRIMARY_MAP = {
  INCOME: "Income",
  TRANSFER_IN: "Transfer",
  TRANSFER_OUT: "Transfer",
  LOAN_PAYMENTS: "Transfer",
  BANK_FEES: "Fees & Charges",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Food & Drink",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Housing",
  MEDICAL: "Healthcare",
  PERSONAL_CARE: "Personal Care",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Utilities",
};

// Suggested category for one row from the deterministic maps (Teller category
// first, then Plaid PFC detailed → primary). Used by the review queue.
function mapCategoryFor(row) {
  const tellerCat = Array.isArray(row.category) && row.category[0] ? String(row.category[0]).toLowerCase() : null;
  if (tellerCat && TELLER_CATEGORY_MAP[tellerCat]) return TELLER_CATEGORY_MAP[tellerCat];
  let pfc = row.personal_finance_category;
  if (typeof pfc === "string") { try { pfc = JSON.parse(pfc); } catch { pfc = null; } }
  if (pfc && pfc.detailed && PLAID_PFC_DETAILED_MAP[pfc.detailed]) return PLAID_PFC_DETAILED_MAP[pfc.detailed];
  if (pfc && pfc.primary && PLAID_PFC_PRIMARY_MAP[pfc.primary]) return PLAID_PFC_PRIMARY_MAP[pfc.primary];
  return null;
}

// Postgres text-array literal of our scheme. Used in the
// "not in our scheme" predicate so rows Teller has tagged with its own
// taxonomy (e.g. 'general', 'dining') are eligible for categorization.
const OUR_CATEGORIES_PG = "{" + CATEGORIES.map(c => '"' + c.replace(/"/g, '\\"') + '"').join(",") + "}";

module.exports = {
  CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  TELLER_CATEGORY_MAP,
  PLAID_PFC_DETAILED_MAP,
  PLAID_PFC_PRIMARY_MAP,
  mapCategoryFor,
  OUR_CATEGORIES_PG,
};
