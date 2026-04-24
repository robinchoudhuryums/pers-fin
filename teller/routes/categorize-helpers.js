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
  accommodation: "Housing",
  utilities: "Utilities",
  phone: "Utilities",
  insurance: "Insurance",
  education: "Education",
  travel: "Travel",
  charity: "Gifts & Donations",
  income: "Income",
  investment: "Investment",
  loan: "Fees & Charges",
  tax: "Fees & Charges",
  software: "Subscription",
};

// Postgres text-array literal of our scheme. Used in the
// "not in our scheme" predicate so rows Teller has tagged with its own
// taxonomy (e.g. 'general', 'dining') are eligible for categorization.
const OUR_CATEGORIES_PG = "{" + CATEGORIES.map(c => '"' + c.replace(/"/g, '\\"') + '"').join(",") + "}";

module.exports = {
  CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  TELLER_CATEGORY_MAP,
  OUR_CATEGORIES_PG,
};
