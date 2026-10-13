-- mlch.app (D1 mlch-accounts): friend codes, the code each account used, and
-- the deletion log. Safe on the live database: the Worker already made the
-- older tables on first use (src/accounts.ts SCHEMA, which also has these).
-- npx wrangler d1 migrations apply mlch-accounts --remote -c wrangler.mlch.jsonc

CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, stripe_customer TEXT UNIQUE, subscription_id TEXT, status TEXT, period_end INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sign_ins (state TEXT PRIMARY KEY, challenge TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, challenge TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id);

-- A friend code: the Stripe promotion code (id), its code, the coupon behind it.
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  coupon_id TEXT NOT NULL UNIQUE,
  percent_off INTEGER NOT NULL,
  max_redemptions INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  deactivated_at INTEGER
);

-- Which friend code an account subscribed with.
CREATE TABLE IF NOT EXISTS account_codes (user_id TEXT PRIMARY KEY, promotion_code_id TEXT NOT NULL, code TEXT NOT NULL, subscription_id TEXT, created_at INTEGER NOT NULL);

-- That an account was deleted, when and by which admin; never whose.
CREATE TABLE IF NOT EXISTS deletions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL);
