/**
 * Recommended fal models per task, checked by hand each release (see
 * scripts/fal-picks.mjs for what is new). media_search lists these first;
 * the AI looks past them only for something specific. Quality is the default;
 * fast when the person asks for drafts, many variations or speed.
 */

export const PICKS_CHECKED = "2026-10-13";

export interface Pick {
  endpoint: string;
  /** Why it is here, in a few words. */
  note: string;
}

export const PICKS: Record<string, { quality: Pick[]; fast: Pick[] }> = {
  "text-to-image": {
    quality: [
      { endpoint: "google/nano-banana-2.1", note: "best all-round, strong text and layouts" },
      { endpoint: "openai/gpt-image-2.5/flare/text-to-image", note: "precise instructions, text in images" },
      { endpoint: "blackforestlabs/flux-3/text-to-image", note: "photographic, styles" },
    ],
    fast: [{ endpoint: "bytedance/seedream/v5/flash/text-to-image", note: "quick and cheap" }],
  },
  "image-to-image": {
    quality: [
      { endpoint: "google/nano-banana-2.1/edit", note: "edits that keep the rest" },
      { endpoint: "openai/gpt-image-2.5/flare/edit", note: "precise edits" },
      { endpoint: "blackforestlabs/flux-3/edit-image", note: "style changes" },
    ],
    fast: [{ endpoint: "bytedance/seedream/v5/flash/edit", note: "quick edits" }],
  },
  "text-to-video": {
    quality: [
      { endpoint: "bytedance/seedance-2.5/text-to-video", note: "4-30 s, with sound" },
      { endpoint: "minimax/h3-max/text-to-video", note: "good value at 1080p" },
    ],
    fast: [
      { endpoint: "minimax/h3-max-turbo/text-to-video", note: "quick" },
      { endpoint: "xai/grok-imagine-video/v1.5/lite/text-to-video", note: "quick drafts" },
    ],
  },
  "image-to-video": {
    quality: [
      { endpoint: "fal-ai/kling-video/v3/pro/image-to-video", note: "3-15 s, optional sound" },
      { endpoint: "bytedance/seedance-2.5/image-to-video", note: "long clips with sound" },
      { endpoint: "minimax/h3-max/image-to-video", note: "good value" },
    ],
    fast: [
      { endpoint: "minimax/h3-max-turbo/image-to-video", note: "quick" },
      { endpoint: "fal-ai/vidu/q4/image-to-video", note: "quick" },
    ],
  },
  "text-to-speech": {
    quality: [{ endpoint: "elevenlabs/tts/eleven-v4", note: "natural voices" }],
    fast: [
      { endpoint: "elevenlabs/tts/eleven-v4-turbo", note: "quick" },
      { endpoint: "google/gemini-3.8-flash-tts", note: "quick, many languages" },
    ],
  },
  "text-to-audio": {
    quality: [
      { endpoint: "google/lyria-3.5", note: "music" },
      { endpoint: "elevenlabs/music/v2.5", note: "music with vocals" },
      { endpoint: "minimax/music-3", note: "songs" },
    ],
    fast: [{ endpoint: "fal-ai/elevenlabs/sound-effects/v2", note: "sound effects" }],
  },
};

/** The picks for a category (all categories when none is given). */
export function picksFor(category?: string): Array<Pick & { category: string; tier: "quality" | "fast" }> {
  const categories = category ? [category] : Object.keys(PICKS);
  return categories.flatMap((c) =>
    PICKS[c] ? [...PICKS[c].quality.map((p) => ({ ...p, category: c, tier: "quality" as const })), ...PICKS[c].fast.map((p) => ({ ...p, category: c, tier: "fast" as const }))] : [],
  );
}
