/**
 * Video pages the canvas can play in place: YouTube and Vimeo. Shared by the
 * app, the server and the share viewer.
 */

export interface VideoEmbed {
  provider: "youtube" | "vimeo";
  id: string;
  /** The player to load in a frame (after a click). */
  embed: string;
  /** A poster image, when the provider has a fixed address for one. */
  poster?: string;
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

export function videoEmbed(value: string | undefined): VideoEmbed | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  let id: string | undefined;
  if (url.hostname === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (YOUTUBE_HOSTS.has(url.hostname)) id = url.searchParams.get("v") ?? /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1];
  if (id && /^[\w-]{6,20}$/.test(id)) {
    return { provider: "youtube", id, embed: `https://www.youtube.com/embed/${id}?rel=0&autoplay=1&playsinline=1`, poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }
  if (url.hostname === "vimeo.com" || url.hostname === "www.vimeo.com" || url.hostname === "player.vimeo.com") {
    const vimeo = /(?:^|\/)(\d{6,12})(?:$|[/?#])/.exec(url.pathname)?.[1];
    if (vimeo) return { provider: "vimeo", id: vimeo, embed: `https://player.vimeo.com/video/${vimeo}?autoplay=1` };
  }
  return undefined;
}

/** Where players may be loaded from: the frame rule in the app and the share page's CSP. */
export const PLAYER_ORIGINS = ["https://www.youtube.com", "https://player.vimeo.com"];
