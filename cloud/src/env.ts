import type { CreateLimiter, ShareRoom } from "./room";

export interface Env {
  /** https://mlch.app: the landing page and the API. */
  APEX_ORIGIN: string;
  /** https://share.mlch.app: shared things, on their own origin. */
  SHARE_ORIGIN: string;
  ASSETS: Fetcher;
  SHARES: R2Bucket;
  ROOMS: DurableObjectNamespace<ShareRoom>;
  LIMITER: DurableObjectNamespace<CreateLimiter>;
  /** A self-hosted server: new shares need this key (X-Mlch-Auth). */
  SERVER_KEY?: string;
  /** mlch.app: "on" means new shares need a signed-in, subscribed person (accounts.ts). */
  ACCOUNTS?: string;
  /** Accounts, sessions and who made which share (mlch.app only). */
  DB?: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** The yearly price's lookup key. */
  STRIPE_PRICE?: string;
  /** Local tests: /auth/dev signs in without Google. */
  DEV_SIGN_IN?: string;
}

export type ShareKind = "artifact" | "mulch";

export const LIMITS = {
  fileBytes: 25_000_000,
  shareBytes: 300_000_000,
  files: 2_000,
  snapshotBytes: 20_000_000,
  opsBytes: 2_000_000,
  titleChars: 200,
  /** New shares per install (or address) per hour. */
  createsPerHour: 60,
};
