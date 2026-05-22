/**
 * Image file extensions accepted for import.
 */
export const IMAGE_EXTENSIONS = [
  // Common
  "png", "jpg", "jpeg", "jfif", "bmp", "dib", "gif", "webp", "tif", "tiff",
  // Icons & portable
  "ico", "cur", "xbm", "xpm",
  // Modern still
  "avif", "avifs", "heic", "heif", "hif", "jxl", "jp2", "j2k", "jpc", "jpx", "qoi",
  // Netpbm / similar
  "pbm", "pgm", "ppm", "pnm", "pam", "pfm",
  // Design / 3D
  "psd", "psb", "svg", "svgz", "tga", "dds", "exr",
  // Camera RAW
  "arw", "cr2", "cr3", "dng", "nef", "nrw", "orf", "raf", "rw2", "raw", "srw",
];

export const VIDEO_EXTENSIONS = ["mp4", "webm"];

const IMAGE_EXT_RE = new RegExp(
  `\\.(${IMAGE_EXTENSIONS.join("|")})(?:[?#]|$)`,
  "i"
);
const VIDEO_EXT_RE = new RegExp(`\\.(${VIDEO_EXTENSIONS.join("|")})(?:[?#]|$)`, "i");

/** @param {string} pathOrName */
export function isGifSource(pathOrName) {
  return /\.gif(?:[?#]|$)/i.test(pathOrName);
}

/** @param {string} pathOrName */
export function isImageExtension(pathOrName) {
  return IMAGE_EXT_RE.test(pathOrName);
}

/** @param {string} pathOrName */
export function isVideoExtension(pathOrName) {
  return VIDEO_EXT_RE.test(pathOrName);
}

/** @param {string} url */
export function isImageUrl(url) {
  try {
    const u = new URL(url);
    return IMAGE_EXT_RE.test(u.pathname);
  } catch {
    return IMAGE_EXT_RE.test(url);
  }
}

/** @param {string} url */
export function isVideoUrl(url) {
  try {
    const u = new URL(url);
    return VIDEO_EXT_RE.test(u.pathname + u.search);
  } catch {
    return VIDEO_EXT_RE.test(url);
  }
}
