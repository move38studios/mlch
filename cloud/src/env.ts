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
