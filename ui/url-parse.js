import {
  isGifSource,
  isImageExtension,
  isImageUrl,
  isVideoExtension,
  isVideoUrl,
} from "./image-formats.js";

/** @typedef {'youtube'|'twitch'|'video'|'file'|'image'|'unknown'} MediaKind */

/**
 * @param {string} raw
 * @returns {{ kind: MediaKind, url: string, id?: string, twitch?: { video?: string, channel?: string, clip?: string } }}
 */
export function parseMediaInput(raw) {
  const text = (raw || "").trim().replace(/^"+|"+$/g, "");
  if (!text) return { kind: "unknown", url: text };

  if (isVideoExtension(text) && !/^https?:/i.test(text)) {
    return { kind: "file", url: text };
  }

  if (isImageExtension(text) && !/^https?:/i.test(text)) {
    return { kind: "image", url: text, isGif: isGifSource(text) };
  }

  if (isVideoUrl(text)) {
    return { kind: "video", url: text };
  }

  if (isImageUrl(text)) {
    return { kind: "image", url: text, isGif: isGifSource(text) };
  }

  const ytId = extractYoutubeId(text);
  if (ytId) return { kind: "youtube", url: text, id: ytId };

  const tw = parseTwitch(text);
  if (tw) return { kind: "twitch", url: text, twitch: tw };

  return { kind: "unknown", url: text };
}

export function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id || null;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|v)\/([^/?]+)/);
      return m ? m[1] : null;
    }
  } catch {
    const m = url.match(
      /(?:youtu\.be\/|youtube\.com\/.*v=)([A-Za-z0-9_-]{6,})/
    );
    return m ? m[1] : null;
  }
  return null;
}

function parseTwitch(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("twitch.tv")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "videos" && parts[1]) return { video: parts[1] };
    if (parts[0] === "clips" && parts[1]) return { clip: parts[1] };
    if (parts.length === 1) return { channel: parts[0] };
  } catch {
    /* ignore */
  }
  return null;
}
