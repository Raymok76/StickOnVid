import { parseMediaInput } from "./url-parse.js";
import {
  isGifSource,
  isImageExtension,
  isVideoExtension,
} from "./image-formats.js";
import { tauriInvoke, tauriListen } from "./tauri-bridge.js";

const canvas = document.getElementById("canvas");
const titleBar = document.getElementById("titleBar");
const emptyState = document.getElementById("emptyState");
const toast = document.getElementById("toast");

const STORAGE_KEY = "stickonvid-tiles-v1";
const FIT_PADDING = 12;
const YOUTUBE_MOUNT_TIMEOUT_MS = 45000;
const YOUTUBE_MOUNT_RETRIES = 2;
/** Matches #titleBar height in styles.css — used for title bar hit-testing only. */
const TITLE_BAR_HEIGHT = 34;
const WINDOW_LABEL = "main";
/** Bottom play/pause bar height — kept outside the Twitch iframe area. */
const TWITCH_CONTROLS_HEIGHT = 40;
const TILE_MARGIN = 12;
/** Minimum gap between tiles when running Optimal Align. */
const ALIGN_GAP = 4;
const GRID_COLS = 2;
const GRID_ROWS = 2;
const GRID_SLOTS = GRID_COLS * GRID_ROWS;
/** Hit area for window edge/corner resize (larger = easier to grab). */
const WINDOW_RESIZE_MARGIN = 24;
const TILE_RESIZE_CORNER = 20;
/** Exponential wheel scaling — works with mouse wheels and trackpads. */
const TILE_WHEEL_SCALE = 0.001;
const TILE_MIN_W = 200;
const TILE_MIN_H = 120;
const TWITCH_TILE_MIN_W = 400;
const TWITCH_TILE_MIN_H = 340;

const RESIZE_CURSORS = {
  North: "ns-resize",
  South: "ns-resize",
  East: "ew-resize",
  West: "ew-resize",
  NorthEast: "nesw-resize",
  NorthWest: "nwse-resize",
  SouthEast: "nwse-resize",
  SouthWest: "nesw-resize",
};

/** @type {Map<string, Tile>} */
const tiles = new Map();
const MAX_VIDEO_TILES = 4;
const MAX_UNDO = 50;
let selectedId = null;
let saveTimer = null;
/** @type {null | "four-tiles"} */
let sessionLayoutMode = null;
/** @type {Array<{ tiles: { source: string, rect: { x: number, y: number, w: number, h: number } }[], selectedId: string | null }>} */
let undoStack = [];
/** @type {typeof undoStack} */
let redoStack = [];
let applyingHistory = false;
let twitchApiPromise = null;
/** Matches #titleBar z-index in styles.css — keep in sync. */
const TITLE_BAR_Z_INDEX = 200000;
/** Twitch iframes sit above the title bar so hover overlays do not pause playback. */
const TWITCH_Z_BASE = TITLE_BAR_Z_INDEX + 1;
let normalTopZ = 0;
let twitchTopZ = TWITCH_Z_BASE - 1;
let shuttingDown = false;

function hasTauriWindow() {
  return !!(window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke);
}

function hasTwitchTiles(excludeId = null) {
  for (const tile of tiles.values()) {
    if (tile.isTwitch && tile.id !== excludeId) return true;
  }
  return false;
}

function bringTileToFront(tile) {
  if (tile.isTwitch) {
    twitchTopZ += 1;
    tile.el.style.zIndex = String(twitchTopZ);
    return;
  }
  normalTopZ += 1;
  tile.el.style.zIndex = String(normalTopZ);
}

function syncAllTileZIndex() {
  normalTopZ = 0;
  twitchTopZ = TWITCH_Z_BASE - 1;
  for (const tile of tiles.values()) {
    if (tile.isTwitch) bringTileToFront(tile);
  }
  for (const tile of tiles.values()) {
    if (!tile.isTwitch) bringTileToFront(tile);
  }
}

function videoTileCount() {
  let n = 0;
  for (const tile of tiles.values()) {
    if (!tile.isImage) n += 1;
  }
  return n;
}

class Tile {
  constructor(
    id,
    parsed,
    rect,
    { autostart = true, deferTwitchMount = false, deferYoutubeMount = false } = {}
  ) {
    this.autostart = autostart;
    this.deferTwitchMount = deferTwitchMount;
    this.deferYoutubeMount = deferYoutubeMount;
    this.preserveTileSize = false;
    this.id = id;
    this.parsed = parsed;
    this.blobUrl = null;
    this.hasCustomControls = parsed.kind === "video" || parsed.kind === "file";
    this.isImage = parsed.kind === "image";
    this.isGif = this.isImage && !!parsed.isGif;
    this.isTwitch = parsed.kind === "twitch";
    this.isYoutube = parsed.kind === "youtube";

    this.el = document.createElement("div");
    this.el.className = this.hasCustomControls ? "tile tile-video" : "tile tile-embed";
    if (this.isImage) this.el.classList.add("tile-image");
    if (this.isGif) this.el.classList.add("tile-gif");
    if (this.isTwitch) this.el.classList.add("tile-twitch");

    this.el.dataset.id = id;
    this.el.style.left = `${rect.x}px`;
    this.el.style.top = `${rect.y}px`;
    this.el.style.width = `${rect.w}px`;
    this.el.style.height = `${rect.h}px`;

    this.body = document.createElement("div");
    this.body.className = "tileBody";
    this.body.tabIndex = -1;

    this.dragHandle = document.createElement("div");
    this.dragHandle.className = "tileDragHandle";
    const dragTitle = this.hasCustomControls
      ? "Drag top or bottom edge to move video"
      : this.isTwitch
        ? "Drag bottom control bar or top edge to move"
        : "Drag top or bottom edge to move";
    this.dragHandle.title = dragTitle;

    if (this.isTwitch) {
      this.dragHandleBottom = null;
      this.body.appendChild(this.dragHandle);
      this.createTwitchControls();
      this.el.classList.add("twitch-paused");
    } else {
      this.body.appendChild(this.dragHandle);
      if (this.hasCustomControls) this.createControls();
      else if (this.isGif) this.createGifControls();
      else this.createEmbedDeleteBtn();
      this.dragHandleBottom = document.createElement("div");
      this.dragHandleBottom.className = "tileDragHandle tileDragHandleBottom";
      this.dragHandleBottom.title = dragTitle;
      this.body.appendChild(this.dragHandleBottom);
    }
    this.el.appendChild(this.body);

    this.backend = null;
    this.setupHover();
  }

  setupHover() {
    this.body.addEventListener("mouseenter", () => {
      this.body.classList.add("is-hover");
      this.maybeResumeTwitchAfterHover();
    });
    this.body.addEventListener("mouseleave", () => {
      this.body.classList.remove("is-hover");
      this.exitYoutubeControlsMode();
    });
  }

  /** Cross-origin YouTube iframes swallow wheel events — shield passes scroll to the canvas. */
  createYoutubeWheelShield() {
    const shield = document.createElement("div");
    shield.className = "ytWheelShield";
    shield.title = "Scroll to resize · Click to use YouTube controls";
    shield.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTile(this.id);
      this.enterYoutubeControlsMode();
    });
    shield.addEventListener("wheel", (e) => {
      if (!resizeTileByWheel(e, this)) return;
      selectTile(this.id);
      e.preventDefault();
    }, { passive: false });
    this.ytWheelShield = shield;
    this.body.insertBefore(shield, this.dragHandle);
  }

  enterYoutubeControlsMode() {
    if (!this.isYoutube || !this.ytFrame) return;
    this.el.classList.add("yt-controls-mode");
  }

  exitYoutubeControlsMode() {
    if (!this.isYoutube) return;
    this.el.classList.remove("yt-controls-mode");
  }

  maybeResumeTwitchAfterHover() {
    if (!this.isTwitch || !this.twitchWantsPlay || this.twitchUserPaused || !this.twitchPlayer) {
      return;
    }
    if (this.el.classList.contains("twitch-needs-activation")) return;
    this.resumeTwitchPlayback();
  }

  /** Resume after a spurious pause — no muted bootstrap (that is for first play only). */
  resumeTwitchPlayback(player = this.twitchPlayer) {
    if (!player || !this.twitchWantsPlay || this.twitchUserPaused) return;
    if (!this.isTwitchPaused()) return;
    try {
      const ret = player.play();
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    } catch {
      /* PAUSE handler may retry */
    }
  }

  createTwitchControls() {
    this.twitchPlaying = false;
    this.twitchWantsPlay = false;
    this.twitchUserPaused = false;
    this.twitchMuted = false;
    this.twitchVolumeValue = 1;
    this.controlsEl = document.createElement("div");
    this.controlsEl.className = "tileControls twitchControls";
    this.twitchControls = this.controlsEl;
    this.btnPlay = document.createElement("button");
    this.btnPlay.type = "button";
    this.btnPlay.className = "twitchPlayBtn";
    this.btnPlay.title = "Play / Pause (Space)";
    this.btnPlay.textContent = "▶ Play";

    this.btnTwitchMute = document.createElement("button");
    this.btnTwitchMute.type = "button";
    this.btnTwitchMute.className = "twitchMuteBtn";
    this.btnTwitchMute.title = "Mute / Unmute";
    this.btnTwitchMute.textContent = "🔊";

    this.twitchVolume = document.createElement("input");
    this.twitchVolume.type = "range";
    this.twitchVolume.className = "twitchVolume";
    this.twitchVolume.min = "0";
    this.twitchVolume.max = "100";
    this.twitchVolume.step = "1";
    this.twitchVolume.value = "100";
    this.twitchVolume.title = "Twitch volume";
    this.twitchVolume.setAttribute("aria-label", "Twitch volume");

    this.btnClose = document.createElement("button");
    this.btnClose.type = "button";
    this.btnClose.className = "twitchCloseBtn";
    this.btnClose.title = "Close stream (Delete)";
    this.btnClose.setAttribute("aria-label", "Close stream");
    this.btnClose.textContent = "×";
    this.btnClose.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.btnClose.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTile(this.id);
    });

    this.controlsEl.append(
      this.btnPlay,
      this.btnTwitchMute,
      this.twitchVolume,
      this.btnClose
    );
    this.body.appendChild(this.controlsEl);
    this.controlsEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".twitchPlayBtn, .twitchMuteBtn, .twitchVolume, .twitchCloseBtn")) {
        e.stopPropagation();
        return;
      }
      if (e.target === this.controlsEl) {
        beginTileDrag(e, this, this.id, this.controlsEl);
        return;
      }
      e.stopPropagation();
    });
    this.btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTile(this.id);
      this.toggleTwitchPlay();
    });
    this.btnTwitchMute.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTile(this.id);
      this.setTwitchMuted(!this.twitchMuted);
    });
    this.twitchVolume.addEventListener("input", (e) => {
      e.stopPropagation();
      selectTile(this.id);
      this.setTwitchVolume(Number(this.twitchVolume.value) / 100);
    });
  }

  getTwitchMuted(player = this.twitchPlayer) {
    try {
      if (player && typeof player.getMuted === "function") {
        return !!player.getMuted();
      }
    } catch {
      /* use fallback below */
    }
    return false;
  }

  getTwitchVolume(player = this.twitchPlayer) {
    try {
      if (player && typeof player.getVolume === "function") {
        const volume = Number(player.getVolume());
        if (Number.isFinite(volume)) return Math.min(1, Math.max(0, volume));
      }
    } catch {
      /* use fallback below */
    }
    return 1;
  }

  renderTwitchVolumeControls() {
    if (!this.btnTwitchMute || !this.twitchVolume) return;
    this.twitchVolume.value = String(Math.round(this.twitchVolumeValue * 100));
    this.btnTwitchMute.textContent =
      this.twitchMuted || this.twitchVolumeValue === 0 ? "🔇" : "🔊";
    this.btnTwitchMute.title = this.twitchMuted ? "Unmute" : "Mute";
  }

  syncTwitchVolumeControls() {
    this.twitchMuted = this.getTwitchMuted();
    this.twitchVolumeValue = this.getTwitchVolume();
    this.renderTwitchVolumeControls();
  }

  setTwitchMuted(muted) {
    const player = this.twitchPlayer;
    if (!player) return;
    this.twitchMuted = !!muted;
    try {
      if (
        !muted &&
        this.getTwitchVolume(player) === 0 &&
        typeof player.setVolume === "function"
      ) {
        player.setVolume(0.5);
        this.twitchVolumeValue = 0.5;
      }
      player.setMuted?.(muted);
    } catch {
      /* ignore Twitch embed errors */
    }
    this.renderTwitchVolumeControls();
  }

  setTwitchVolume(volume) {
    const player = this.twitchPlayer;
    if (!player) return;
    const nextVolume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    this.twitchVolumeValue = nextVolume;
    this.twitchMuted = nextVolume === 0;
    try {
      player.setVolume?.(nextVolume);
      player.setMuted?.(nextVolume === 0);
    } catch {
      /* ignore Twitch embed errors */
    }
    this.renderTwitchVolumeControls();
  }

  getTwitchEmbedSize() {
    const w = Math.max(400, Math.floor(this.el.clientWidth || 400));
    const h = Math.max(
      300,
      Math.floor((this.el.clientHeight || 300) - TWITCH_CONTROLS_HEIGHT)
    );
    return { width: w, height: h };
  }

  isTwitchPaused() {
    const player = this.twitchPlayer;
    if (player && typeof player.getPaused === "function") {
      return player.getPaused();
    }
    return !this.twitchPlaying;
  }

  setTwitchPlaying(playing) {
    this.twitchPlaying = playing;
    if (playing) this.twitchWantsPlay = true;
    this.el.classList.remove("twitch-needs-activation");
    clearTimeout(this.twitchActivationWatch);
    this.el.classList.toggle("twitch-paused", !playing);
    this.el.classList.toggle("twitch-playing", !!playing);
    if (this.btnPlay) {
      this.btnPlay.disabled = false;
      this.btnPlay.textContent = playing ? "❚❚ Pause" : "▶ Play";
      this.btnPlay.title = playing
        ? "Pause (Space)"
        : "Play (Space) — may need one click in the stream";
    }
  }

  setTwitchPlayLoading(loading) {
    if (!this.btnPlay) return;
    this.btnPlay.disabled = loading;
    if (loading) this.btnPlay.textContent = "…";
  }

  beginTwitchActivationMode() {
    this.el.classList.add("twitch-needs-activation");
    this.setTwitchPlayLoading(false);
    if (this.btnPlay) {
      this.btnPlay.textContent = "Click video above";
      this.btnPlay.title = "Click once in the stream area above to start";
    }
    clearTimeout(this.twitchActivationWatch);
    this.twitchActivationWatch = setTimeout(() => {
      if (
        this.el.classList.contains("twitch-needs-activation") &&
        this.isTwitchPaused()
      ) {
        showToast(
          "Click the stream once above. If it still fails, wait a few minutes (429) and try again."
        );
      }
    }, 12000);
  }

  checkTwitchPlayAfterAttempt() {
    if (!this.isTwitchPaused()) {
      this.setTwitchPlaying(true);
      return;
    }
    this.beginTwitchActivationMode();
  }

  invokeTwitchPlay(player) {
    this.twitchPlayMutedBootstrap = false;
    try {
      if (typeof player.setMuted === "function") {
        this.twitchMutedBeforeBootstrap = this.twitchMuted;
        player.setMuted(true);
        this.twitchPlayMutedBootstrap = true;
      }
      const ret = player.play();
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    } catch {
      /* check below */
    }
  }

  toggleTwitchPlay() {
    const player = this.twitchPlayer;
    if (!player) {
      this.loadDeferredTwitchAndPlay();
      return;
    }
    if (!this.isTwitchPaused()) {
      this.twitchUserPaused = true;
      this.twitchWantsPlay = false;
      this.el.classList.remove("twitch-needs-activation");
      clearTimeout(this.twitchActivationWatch);
      player.pause();
      return;
    }
    this.twitchUserPaused = false;
    this.twitchWantsPlay = true;
    this.el.classList.remove("twitch-needs-activation");
    clearTimeout(this.twitchActivationWatch);
    this.setTwitchPlayLoading(true);
    this.invokeTwitchPlay(player);
    clearTimeout(this.twitchPlayWatch);
    this.twitchPlayWatch = setTimeout(() => this.checkTwitchPlayAfterAttempt(), 400);
  }

  mountDeferredTwitch(tw) {
    const placeholder = document.createElement("div");
    placeholder.className = "twitchEmbedHost twitchPlaceholder";
    placeholder.textContent = "Twitch stream paused — press Play to load";
    this.body.insertBefore(placeholder, this.twitchControls);
    this.twitchDeferred = tw;
    this.twitchPlaceholder = placeholder;
    this.backend = { kind: "twitch" };
    this.setTwitchPlaying(false);
    this.renderTwitchVolumeControls();
    return this.backend;
  }

  async loadDeferredTwitchAndPlay() {
    if (!this.twitchDeferred || this.twitchLoadingDeferred) return;
    const tw = this.twitchDeferred;
    this.twitchDeferred = null;
    this.twitchLoadingDeferred = true;
    this.twitchUserPaused = false;
    this.twitchWantsPlay = true;
    this.setTwitchPlayLoading(true);
    this.twitchPlaceholder?.remove();
    this.twitchPlaceholder = null;
    try {
      await this.mountTwitch(tw);
      this.toggleTwitchPlay();
    } catch (err) {
      document.getElementById(`tw-${this.id}`)?.remove();
      this.twitchPlayer = null;
      showToast(String(err?.message || err));
      this.mountDeferredTwitch(tw);
      this.setTwitchPlayLoading(false);
    } finally {
      this.twitchLoadingDeferred = false;
    }
  }

  createControls() {
    this.controlsEl = document.createElement("div");
    this.controlsEl.className = "tileControls";

    this.btnPlay = document.createElement("button");
    this.btnPlay.type = "button";
    this.btnPlay.title = "Play / Pause";
    this.btnPlay.textContent = "▶";

    this.seek = document.createElement("input");
    this.seek.type = "range";
    this.seek.min = "0";
    this.seek.max = "1000";
    this.seek.value = "0";
    this.seek.step = "1";

    this.timeLabel = document.createElement("span");
    this.timeLabel.className = "tileTime";
    this.timeLabel.textContent = "0:00 / 0:00";

    this.btnMute = document.createElement("button");
    this.btnMute.type = "button";
    this.btnMute.title = "Mute";
    this.btnMute.textContent = "🔇";

    this.controlsEl.append(this.btnPlay, this.seek, this.timeLabel, this.btnMute);
    this.body.appendChild(this.controlsEl);

    this.controlsEl.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.backend) return;
      if (this.backend.isPaused()) this.backend.play();
      else this.backend.pause();
      this.syncControls();
    });

    this.btnMute.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.backend) return;
      this.backend.setMuted(!this.backend.isMuted());
      this.syncControls();
    });

    this.seek.addEventListener("input", (e) => e.stopPropagation());
    this.seek.addEventListener("change", (e) => {
      e.stopPropagation();
      if (!this.backend) return;
      this.backend.seek(Number(this.seek.value) / 10);
      this.syncControls();
    });
  }

  createEmbedDeleteBtn() {
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.type = "button";
    this.deleteBtn.className = "tileDeleteBtn";
    this.deleteBtn.title = "Remove (Delete)";
    this.deleteBtn.textContent = "×";
    this.deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTile(this.id);
    });
    this.body.appendChild(this.deleteBtn);
  }

  createGifControls() {
    this.gifPaused = false;
    this.gifAnimSrc = null;
    this.controlsEl = document.createElement("div");
    this.controlsEl.className = "tileControls gifControls";

    this.btnPlay = document.createElement("button");
    this.btnPlay.type = "button";
    this.btnPlay.title = "Play / Pause GIF (Space)";
    this.btnPlay.textContent = "❚❚";

    this.btnClose = document.createElement("button");
    this.btnClose.type = "button";
    this.btnClose.className = "gifCloseBtn";
    this.btnClose.title = "Remove (Delete)";
    this.btnClose.textContent = "×";

    this.controlsEl.append(this.btnPlay, this.btnClose);
    this.body.appendChild(this.controlsEl);
    this.controlsEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTile(this.id);
      this.toggleGifPlay();
    });
    this.btnClose.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTile(this.id);
    });
  }

  syncGifControls() {
    if (!this.isGif || !this.btnPlay) return;
    this.btnPlay.textContent = this.gifPaused ? "▶" : "❚❚";
  }

  toggleGifPlay() {
    if (this.gifPaused) this.playGif();
    else this.pauseGif();
  }

  pauseGif() {
    const img = this.imageEl;
    if (!img || this.gifPaused) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      this.gifAnimSrc = img.src;
      img.src = canvas.toDataURL("image/png");
      this.gifPaused = true;
      this.syncGifControls();
    } catch {
      showToast("Could not pause GIF");
    }
  }

  playGif() {
    const img = this.imageEl;
    if (!img || !this.gifPaused || !this.gifAnimSrc) return;
    img.src = this.gifAnimSrc;
    this.gifPaused = false;
    this.syncGifControls();
  }

  syncControls() {
    if (!this.hasCustomControls || !this.controlsEl || !this.backend) return;
    this.btnPlay.textContent = this.backend.isPaused() ? "▶" : "❚❚";
    this.btnMute.textContent = this.backend.isMuted() ? "🔇" : "🔊";
    const { current, duration } = this.backend.getTimes();
    this.seek.max = String(Math.max(1, Math.floor(duration * 10) || 1000));
    this.seek.value = String(Math.floor(current * 10));
    this.timeLabel.textContent = `${fmt(current)} / ${fmt(duration)}`;
  }

  startSync() {
    if (!this.hasCustomControls) return;
    this.stopSync();
    if (this.backend?.onTimeUpdate) {
      this.backend.onTimeUpdate(() => this.syncControls());
    }
  }

  stopSync() {
    this.backend?.onTimeUpdate?.(null);
  }

  mount() {
    const { kind, url, id, twitch } = this.parsed;
    if (kind === "youtube" && id) {
      if (this.deferYoutubeMount && !this.autostart) {
        return this.mountDeferredYoutube(id);
      }
      return this.mountYoutube(id);
    }
    if (kind === "twitch" && twitch) {
      if (this.deferTwitchMount && !this.autostart) {
        return this.mountDeferredTwitch(twitch);
      }
      return this.mountTwitch(twitch);
    }
    if (kind === "video" || kind === "file") return this.mountVideo(url);
    if (kind === "image") return this.mountImage(url);
    throw new Error("Unsupported media");
  }

  fitImageTileSize(img) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const maxW = 640;
    const maxH = 480;
    let w = nw;
    let h = nh;
    if (w > maxW) {
      h = (h * maxW) / w;
      w = maxW;
    }
    if (h > maxH) {
      w = (w * maxH) / h;
      h = maxH;
    }
    this.el.style.width = `${Math.max(200, Math.round(w))}px`;
    this.el.style.height = `${Math.max(120, Math.round(h))}px`;
  }

  mountImage(src) {
    const fileSrc =
      src.startsWith("data:") ||
      src.startsWith("blob:") ||
      src.startsWith("file:") ||
      /^https?:/i.test(src)
        ? src
        : convertFileSrc(src);
    const img = document.createElement("img");
    img.className = "tileImage";
    img.alt = "";
    img.draggable = false;
    img.src = fileSrc;
    this.imageEl = img;
    if (this.isGif) this.gifAnimSrc = fileSrc;
    this.body.insertBefore(img, this.dragHandle);
    return new Promise((resolve, reject) => {
      img.addEventListener("load", () => {
        if (!this.preserveTileSize) {
          this.fitImageTileSize(img);
        }
        this.backend = { kind: this.isGif ? "gif" : "image" };
        this.syncGifControls();
        resolve(this.backend);
      });
      img.addEventListener("error", () => {
        reject(new Error(`Cannot display image: ${src.split(/[/\\]/).pop()}`));
      });
    });
  }

  mountVideo(src) {
    const fileSrc =
      this.parsed.kind === "file" && !src.startsWith("file:") && !src.startsWith("blob:")
        ? convertFileSrc(src)
        : src;
    const video = document.createElement("video");
    video.src = fileSrc;
    video.loop = true;
    video.muted = false;
    video.playsInline = true;
    video.controls = false;
    video.autoplay = false;
    video.preload = "metadata";
    this.body.insertBefore(video, this.dragHandle);
    const backend = makeHtml5Backend(video);
    this.backend = backend;
    video.addEventListener("loadedmetadata", () => {
      if (!this.autostart) {
        video.pause();
        video.currentTime = 0;
      } else {
        video.play().catch(() => {});
      }
      this.syncControls();
    });
    video.addEventListener("error", () => {
      showToast(`Cannot play video: ${src.split(/[/\\]/).pop()}`);
    });
    this.startSync();
    return backend;
  }

  mountDeferredYoutube(videoId) {
    const placeholder = document.createElement("div");
    placeholder.className = "ytEmbedHost ytPlaceholder";
    placeholder.textContent = "YouTube paused — click or press Space to load";
    placeholder.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTile(this.id);
      this.loadDeferredYoutube();
    });
    this.body.insertBefore(placeholder, this.dragHandle);
    this.youtubeDeferred = videoId;
    this.youtubePlaceholder = placeholder;
    this.backend = { kind: "youtube" };
    return this.backend;
  }

  async loadDeferredYoutube() {
    if (!this.youtubeDeferred || this.youtubeLoadingDeferred) return;
    const videoId = this.youtubeDeferred;
    this.youtubeDeferred = null;
    this.youtubeLoadingDeferred = true;
    this.youtubePlaceholder?.remove();
    this.youtubePlaceholder = null;
    try {
      await this.mountYoutube(videoId);
    } catch (err) {
      showToast(String(err?.message || err));
      this.mountDeferredYoutube(videoId);
    } finally {
      this.youtubeLoadingDeferred = false;
    }
  }

  async mountYoutube(videoId) {
    let lastErr;
    for (let attempt = 0; attempt < YOUTUBE_MOUNT_RETRIES; attempt++) {
      if (attempt > 0) {
        this.ytWheelShield?.remove();
        this.ytWheelShield = null;
        this.ytFrame?.remove();
        this.ytFrame = null;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      try {
        return await this.mountYoutubeOnce(videoId);
      } catch (err) {
        lastErr = err;
      }
    }
    this.ytWheelShield?.remove();
    this.ytWheelShield = null;
    this.ytFrame?.remove();
    this.ytFrame = null;
    throw lastErr;
  }

  mountYoutubeOnce(videoId) {
    const iframe = document.createElement("iframe");
    iframe.className = "ytFrame";
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    const autoplay = this.autostart ? 1 : 0;
    iframe.src =
      `https://www.youtube.com/embed/${encodeURIComponent(videoId)}` +
      `?autoplay=${autoplay}&mute=0&controls=1&modestbranding=1&rel=0&playsinline=1` +
      `&start=0&loop=1&playlist=${encodeURIComponent(videoId)}`;

    this.body.insertBefore(iframe, this.dragHandle);
    this.ytFrame = iframe;
    this.createYoutubeWheelShield();
    this.backend = { kind: "youtube" };

    return new Promise((resolve, reject) => {
      clearTimeout(this.youtubeMountFailTimer);
      this.youtubeMountFailTimer = setTimeout(() => {
        this.youtubeMountFailTimer = null;
        reject(new Error("YouTube embed timed out"));
      }, YOUTUBE_MOUNT_TIMEOUT_MS);

      iframe.addEventListener("load", () => {
        clearTimeout(this.youtubeMountFailTimer);
        this.youtubeMountFailTimer = null;
        resolve(this.backend);
      });

      iframe.addEventListener("error", () => {
        clearTimeout(this.youtubeMountFailTimer);
        this.youtubeMountFailTimer = null;
        reject(new Error("YouTube embed failed to load"));
      });
    });
  }

  async mountTwitch(tw) {
    await waitForTwitchApi();
    const host = document.createElement("div");
    host.id = `tw-${this.id}`;
    host.className = "twitchEmbedHost";
    this.body.insertBefore(host, this.twitchControls);
    const { width, height } = this.getTwitchEmbedSize();
    const opts = {
      width,
      height,
      autoplay: false,
      muted: false,
      parent: twitchParentDomains(),
    };
    if (tw.video) opts.video = tw.video;
    else if (tw.clip) opts.clip = tw.clip;
    else if (tw.channel) opts.channel = tw.channel;
    const player = new Twitch.Player(host.id, opts);
    this.twitchPlayer = player;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (backend) => {
        if (settled) return;
        settled = true;
        resolve(backend);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      player.addEventListener(Twitch.Player.READY, () => {
        this.setTwitchPlaying(false);
        this.syncTwitchVolumeControls();
        player.addEventListener(Twitch.Player.PLAY, () => {
          clearTimeout(this.twitchPlayWatch);
          clearTimeout(this.twitchActivationWatch);
          this.twitchUserPaused = false;
          if (
            this.twitchPlayMutedBootstrap &&
            typeof player.setMuted === "function"
          ) {
            this.twitchMuted = !!this.twitchMutedBeforeBootstrap;
            player.setMuted(this.twitchMuted);
            this.twitchPlayMutedBootstrap = false;
          }
          this.setTwitchPlaying(true);
          this.renderTwitchVolumeControls();
        });
        player.addEventListener(Twitch.Player.PAUSE, () => {
          clearTimeout(this.twitchPlayWatch);
          if (this.twitchUserPaused || !this.twitchWantsPlay) {
            this.setTwitchPlaying(false);
            return;
          }
          this.setTwitchPlaying(false);
          clearTimeout(this.twitchSpuriousPauseWatch);
          this.twitchSpuriousPauseWatch = setTimeout(() => {
            if (this.twitchWantsPlay && !this.twitchUserPaused && this.isTwitchPaused()) {
              this.resumeTwitchPlayback(player);
            }
          }, 80);
        });
        if (Twitch.Player.ERROR) {
          player.addEventListener(Twitch.Player.ERROR, () =>
            this.beginTwitchActivationMode()
          );
        }
        if (this.autostart) {
          requestAnimationFrame(() => this.toggleTwitchPlay());
        }
        this.backend = { kind: "twitch" };
        finish(this.backend);
      });
      player.addEventListener(Twitch.Player.OFFLINE, () => {
        fail(new Error("Twitch stream offline"));
      });
    });
  }

  select() {
    this.el.classList.add("selected");
    selectedId = this.id;
    if (this.hasCustomControls) this.syncControls();
  }

  deselect() {
    this.el.classList.remove("selected");
  }

  destroy() {
    clearTimeout(this.twitchPlayWatch);
    clearTimeout(this.twitchSpuriousPauseWatch);
    clearTimeout(this.twitchActivationWatch);
    clearTimeout(this.resizeEndTimer);
    clearTimeout(this.youtubeMountFailTimer);
    this.youtubeMountFailTimer = null;
    this.stopSync();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try {
      this.twitchPlayer?.pause?.();
    } catch {
      /* closing anyway */
    }
    if (this.twitchPlayer) {
      const host = document.getElementById(`tw-${this.id}`);
      if (host) host.replaceChildren();
      this.twitchPlayer = null;
    }
    this.twitchPlaceholder?.remove();
    this.twitchPlaceholder = null;
    const video = this.body?.querySelector("video");
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* closing anyway */
      }
    }
    this.ytFrame?.remove();
    this.ytFrame = null;
    this.ytWheelShield?.remove();
    this.ytWheelShield = null;
    this.youtubePlaceholder?.remove();
    this.youtubePlaceholder = null;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.el.remove();
  }
}

function makeHtml5Backend(video) {
  let timeListener = null;
  return {
    kind: "video",
    play: () => video.play(),
    pause: () => video.pause(),
    isPaused: () => video.paused,
    getTimes: () => ({
      current: video.currentTime,
      duration: video.duration || 0,
    }),
    seek: (t) => {
      video.currentTime = t;
    },
    setMuted: (m) => {
      video.muted = m;
    },
    isMuted: () => video.muted,
    onTimeUpdate: (fn) => {
      if (timeListener) video.removeEventListener("timeupdate", timeListener);
      timeListener = fn ? () => fn() : null;
      if (timeListener) video.addEventListener("timeupdate", timeListener);
    },
  };
}

function convertFileSrc(path) {
  if (window.__TAURI__?.core?.convertFileSrc) {
    return window.__TAURI__.core.convertFileSrc(path);
  }
  return path.startsWith("file:") ? path : `file:///${path.replace(/\\/g, "/")}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function blobUrlToDataUrl(blobUrl) {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return readFileAsDataUrl(blob);
}

function parsedFromSavedItem(item) {
  const source = item?.source;
  if (!source) return { kind: "unknown", url: "" };
  if (source.startsWith("data:image/")) {
    return {
      kind: "image",
      url: source,
      isGif: !!item.isGif || isGifSource(source),
    };
  }
  const parsed = parseMediaInput(source);
  if (parsed.kind === "image" && item.isGif != null) {
    parsed.isGif = item.isGif;
  }
  return parsed;
}

function minTileTop() {
  return TITLE_BAR_HEIGHT;
}

function clampRectBelowTitleBar(rect) {
  const minY = minTileTop();
  return {
    x: rect.x,
    y: Math.max(rect.y, minY),
    w: rect.w,
    h: rect.h,
  };
}

function nextTileRect() {
  const n = tiles.size;
  const minY = minTileTop();
  return findRectAvoidingTwitch({
    x: TILE_MARGIN + n * 28,
    y: minY + n * 28,
    w: 480,
    h: 270,
  });
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

function rectsOverlapWithGap(a, b, gap) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

function layoutItemOverlapsOthers(rect, items, excludeId, gap) {
  for (const item of items) {
    if (item.id === excludeId) continue;
    if (rectsOverlapWithGap(rect, item.rect, gap)) return true;
  }
  return false;
}

function buildLayoutItems() {
  return [...tiles.values()].map((tile) => {
    const rect = tileRectFromEl(tile);
    return {
      id: tile.id,
      tile,
      orig: { ...rect },
      rect: { ...rect },
    };
  });
}

function findMinimalDisplacementPosition(item, placed, gap) {
  const { orig, rect } = item;
  const w = rect.w;
  const h = rect.h;
  const minY = minTileTop();
  const tryAt = (x, y) => {
    const candidate = {
      x: Math.max(0, Math.round(x)),
      y: Math.max(minY, Math.round(y)),
      w,
      h,
    };
    if (!layoutItemOverlapsOthers(candidate, placed, item.id, gap)) {
      return candidate;
    }
    return null;
  };

  const atOrigin = tryAt(orig.x, orig.y);
  if (atOrigin) return atOrigin;

  const step = 8;
  const maxRadius = 2400;
  const candidates = [];
  for (let radius = step; radius <= maxRadius; radius += step) {
    for (let x = orig.x - radius; x <= orig.x + radius; x += step) {
      candidates.push({ x, y: orig.y - radius });
      candidates.push({ x, y: orig.y + radius });
    }
    for (let y = orig.y - radius + step; y <= orig.y + radius - step; y += step) {
      candidates.push({ x: orig.x - radius, y });
      candidates.push({ x: orig.x + radius, y });
    }
  }
  candidates.sort((a, b) => {
    const da = (a.x - orig.x) ** 2 + (a.y - orig.y) ** 2;
    const db = (b.x - orig.x) ** 2 + (b.y - orig.y) ** 2;
    return da - db;
  });
  for (const candidate of candidates) {
    const placedRect = tryAt(candidate.x, candidate.y);
    if (placedRect) return placedRect;
  }
  return { x: Math.max(0, orig.x), y: Math.max(minY, orig.y), w, h };
}

function compactLayoutItems(items, gap) {
  const step = 4;
  const minY = minTileTop();
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    items.sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
    for (const item of items) {
      let nx = item.rect.x;
      while (nx > 0) {
        const next = Math.max(0, nx - step);
        const trial = { ...item.rect, x: next };
        if (layoutItemOverlapsOthers(trial, items, item.id, gap)) break;
        nx = next;
        if (nx === 0) break;
      }
      if (nx !== item.rect.x) {
        item.rect.x = nx;
        moved = true;
      }
    }
    items.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    for (const item of items) {
      let ny = item.rect.y;
      while (ny > minY) {
        const next = Math.max(minY, ny - step);
        const trial = { ...item.rect, y: next };
        if (layoutItemOverlapsOthers(trial, items, item.id, gap)) break;
        ny = next;
        if (ny === minY) break;
      }
      if (ny !== item.rect.y) {
        item.rect.y = ny;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function computeOptimalTileLayout() {
  const items = buildLayoutItems();
  if (items.length === 0) return items;
  items.sort(
    (a, b) => a.orig.y - b.orig.y || a.orig.x - b.orig.x || b.rect.w * b.rect.h - a.rect.w * a.rect.h
  );
  const placed = [];
  for (const item of items) {
    item.rect = findMinimalDisplacementPosition(item, placed, ALIGN_GAP);
    placed.push(item);
  }
  compactLayoutItems(items, ALIGN_GAP);
  return items;
}

function shiftTilesToFitPadding() {
  const { minX, minY } = getTilesBounds();
  const offsetX = FIT_PADDING - minX;
  const offsetY = minTileTop() - minY;
  for (const tile of tiles.values()) {
    tile.el.style.left = `${tile.el.offsetLeft + offsetX}px`;
    tile.el.style.top = `${tile.el.offsetTop + offsetY}px`;
  }
}

async function setWindowToLogicalSize(width, height, actionLabel) {
  try {
    const maximized = await tauriInvoke("plugin:window|is_maximized", { label: WINDOW_LABEL });
    if (maximized) {
      await tauriInvoke("plugin:window|toggle_maximize", { label: WINDOW_LABEL });
    }
    await tauriInvoke("plugin:window|set_size", {
      label: WINDOW_LABEL,
      value: {
        Logical: {
          width: Math.max(320, Math.ceil(width)),
          height: Math.max(180, Math.ceil(height)),
        },
      },
    });
    flushSaveState();
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("Tauri IPC unavailable")) {
      showToast(`${actionLabel} only works in the StickOnVid desktop app`);
    } else {
      showToast(`${actionLabel} failed: ${msg}`);
    }
    console.error(err);
  }
}

async function setWindowToTileBounds(actionLabel) {
  const { minX, minY, maxX, maxY } = getTilesBounds();
  const width = maxX - minX + FIT_PADDING * 2;
  const height = maxY - minY + FIT_PADDING * 2;
  await setWindowToLogicalSize(width, height, actionLabel);
}

function getTwitchRects(excludeId = null) {
  const rects = [];
  for (const tile of tiles.values()) {
    if (!tile.isTwitch || tile.id === excludeId) continue;
    rects.push(tileRectFromEl(tile));
  }
  return rects;
}

function overlapsAnyTwitch(rect, excludeId = null) {
  return getTwitchRects(excludeId).some((other) => rectsOverlap(rect, other));
}

function findRectAvoidingTwitch(rect, excludeId = null) {
  const base = { ...rect };
  if (!hasTwitchTiles(excludeId) || !overlapsAnyTwitch(base, excludeId)) {
    return base;
  }

  const step = TILE_MARGIN + 28;
  for (let i = 1; i <= 240; i++) {
    const ring = Math.ceil(i / 8);
    const angle = i * 0.65;
    const candidate = {
      x: Math.round(base.x + Math.cos(angle) * step * ring),
      y: Math.round(base.y + Math.sin(angle) * step * ring),
      w: base.w,
      h: base.h,
    };
    if (!overlapsAnyTwitch(candidate, excludeId)) return candidate;
  }
  return base;
}

function tileAtPositionOverlapsTwitch(tile, x, y) {
  return overlapsAnyTwitch(
    {
      x,
      y,
      w: tile.el.offsetWidth,
      h: tile.el.offsetHeight,
    },
    tile.id
  );
}

function resolveTilePlacementsAvoidingTwitch() {
  for (const tile of tiles.values()) {
    let rect = tileRectFromEl(tile);
    rect = findRectAvoidingTwitch(rect, tile.id);
    rect = clampRectBelowTitleBar(rect);
    if (
      rect.x !== tile.el.offsetLeft ||
      rect.y !== tile.el.offsetTop ||
      rect.w !== tile.el.offsetWidth ||
      rect.h !== tile.el.offsetHeight
    ) {
      applyTileRect(tile, rect);
    }
  }
}

function clearSessionLayoutMode() {
  sessionLayoutMode = null;
}

function tileRectFromEl(tile) {
  const parsedLeft = parseInt(tile.el.style.left, 10);
  const parsedTop = parseInt(tile.el.style.top, 10);
  const parsedW = parseInt(tile.el.style.width, 10);
  const parsedH = parseInt(tile.el.style.height, 10);
  return {
    x: Number.isFinite(parsedLeft) ? parsedLeft : tile.el.offsetLeft,
    y: Number.isFinite(parsedTop) ? parsedTop : tile.el.offsetTop,
    w: Number.isFinite(parsedW) ? parsedW : tile.el.offsetWidth,
    h: Number.isFinite(parsedH) ? parsedH : tile.el.offsetHeight,
  };
}

function applyTileRect(tile, rect) {
  tile.el.style.left = `${rect.x}px`;
  tile.el.style.top = `${rect.y}px`;
  tile.el.style.width = `${rect.w}px`;
  tile.el.style.height = `${rect.h}px`;
}

function tileContentKey(parsed) {
  return `${parsed.kind}|${parsed.url}|${parsed.id || ""}|${JSON.stringify(parsed.twitch || null)}`;
}

function sameTileContent(tile, parsed) {
  return tileContentKey(tile.parsed) === tileContentKey(parsed);
}

function parsedFromSnapshotItem(item) {
  const parsed =
    item.parsed ||
    (item.source ? parseMediaInput(item.source) : { kind: "unknown", url: "" });
  if (parsed.kind === "image" && parsed.isGif == null) {
    parsed.isGif = isGifSource(parsed.url);
  }
  return parsed;
}

function snapshotUsesStableIds(snap) {
  const items = snap.tiles || [];
  return items.length > 0 && items.every((item) => item.id);
}

function serializeDocument() {
  const items = [];
  for (const tile of tiles.values()) {
    const url = tile.parsed.url;
    if (!url) continue;
    items.push({
      id: tile.id,
      parsed: {
        kind: tile.parsed.kind,
        url: tile.parsed.url,
        id: tile.parsed.id,
        twitch: tile.parsed.twitch,
        isGif: tile.parsed.isGif,
      },
      rect: tileRectFromEl(tile),
      zIndex: Number(tile.el.style.zIndex) || 0,
    });
  }
  return { tiles: items, selectedId };
}

function pushUndoSnapshot() {
  if (applyingHistory) return;
  undoStack.push(serializeDocument());
  redoStack = [];
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

async function restoreFromSnapshotLegacy(snap) {
  for (const id of [...tiles.keys()]) {
    const tile = tiles.get(id);
    tile?.destroy();
    tiles.delete(id);
  }
  selectedId = null;
  for (const item of snap.tiles || []) {
    const parsed = parsedFromSnapshotItem(item);
    if (parsed.kind === "unknown") continue;
    await addTile(parsed, item.rect, {
      autostart: false,
      skipHistory: true,
      deferTwitchMount: parsed.kind === "twitch",
      deferYoutubeMount: parsed.kind === "youtube",
    });
  }
  if (snap.selectedId && tiles.has(snap.selectedId)) {
    selectTile(snap.selectedId);
  }
  resolveTilePlacementsAvoidingTwitch();
  syncAllTileZIndex();
  emptyState.classList.toggle("hidden", tiles.size > 0);
}

async function restoreFromSnapshotInPlace(snap) {
  const snapItems = (snap.tiles || []).filter((item) => {
    const parsed = parsedFromSnapshotItem(item);
    return parsed.kind !== "unknown";
  });
  const keptIds = new Set();

  for (const item of snapItems) {
    const parsed = parsedFromSnapshotItem(item);
    const rect = item.rect || nextTileRect();
    const existing = item.id ? tiles.get(item.id) : null;

    if (existing && sameTileContent(existing, parsed)) {
      applyTileRect(existing, rect);
      if (item.zIndex != null && existing.isTwitch) {
        existing.el.style.zIndex = String(item.zIndex);
        twitchTopZ = Math.max(twitchTopZ, item.zIndex);
      }
      keptIds.add(existing.id);
      continue;
    }

    if (existing) {
      existing.destroy();
      tiles.delete(existing.id);
    }

    await addTile(parsed, rect, {
      id: item.id,
      autostart: false,
      skipHistory: true,
      deferTwitchMount: parsed.kind === "twitch",
      deferYoutubeMount: parsed.kind === "youtube",
    });
    if (item.id) {
      keptIds.add(item.id);
      const created = tiles.get(item.id);
      if (created && item.zIndex != null && created.isTwitch) {
        created.el.style.zIndex = String(item.zIndex);
        twitchTopZ = Math.max(twitchTopZ, item.zIndex);
      }
    }
  }

  for (const id of [...tiles.keys()]) {
    if (keptIds.has(id)) continue;
    tiles.get(id)?.destroy();
    tiles.delete(id);
  }

  resolveTilePlacementsAvoidingTwitch();
  syncAllTileZIndex();

  selectedId = null;
  if (snap.selectedId && tiles.has(snap.selectedId)) {
    selectTile(snap.selectedId);
  } else {
    for (const tile of tiles.values()) tile.deselect();
  }
  emptyState.classList.toggle("hidden", tiles.size > 0);
}

async function restoreFromSnapshot(snap) {
  applyingHistory = true;
  if (snapshotUsesStableIds(snap)) {
    await restoreFromSnapshotInPlace(snap);
  } else {
    await restoreFromSnapshotLegacy(snap);
  }
  applyingHistory = false;
  scheduleSaveState();
}

async function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(serializeDocument());
  const snap = undoStack.pop();
  await restoreFromSnapshot(snap);
}

async function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(serializeDocument());
  const snap = redoStack.pop();
  await restoreFromSnapshot(snap);
}

function isHistoryKeyTarget(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function beginTileDrag(e, tile, id, captureEl) {
  e.preventDefault();
  e.stopPropagation();
  clearSessionLayoutMode();
  pushUndoSnapshot();
  selectTile(id);

  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = tile.el.offsetLeft;
  const startTop = tile.el.offsetTop;
  let lastLeft = startLeft;
  let lastTop = startTop;

  captureEl.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const nextLeft = startLeft + dx;
    const nextTop = startTop + dy;
    if (tileAtPositionOverlapsTwitch(tile, nextLeft, nextTop)) {
      tile.el.style.left = `${lastLeft}px`;
      tile.el.style.top = `${lastTop}px`;
      return;
    }
    tile.el.style.left = `${nextLeft}px`;
    tile.el.style.top = `${nextTop}px`;
    lastLeft = nextLeft;
    lastTop = nextTop;
  };

  const onUp = (ev) => {
    captureEl.releasePointerCapture(ev.pointerId);
    captureEl.removeEventListener("pointermove", onMove);
    captureEl.removeEventListener("pointerup", onUp);
    captureEl.removeEventListener("pointercancel", onUp);
    scheduleSaveState();
  };

  captureEl.addEventListener("pointermove", onMove);
  captureEl.addEventListener("pointerup", onUp);
  captureEl.addEventListener("pointercancel", onUp);
}

function enableTileDrag(tile, id) {
  const handles = tile.isTwitch
    ? [tile.dragHandle]
    : [tile.dragHandle, tile.dragHandleBottom].filter(Boolean);
  for (const handle of handles) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      beginTileDrag(e, tile, id, handle);
    });
  }
}

function observeTileResize(tile) {
  tile.resizeUndoPushed = false;
  tile.resizeObserver = new ResizeObserver(() => {
    if (tile.historyReady && !applyingHistory && !tile.resizeUndoPushed) {
      tile.resizeUndoPushed = true;
      pushUndoSnapshot();
    }
    clearTimeout(tile.resizeEndTimer);
    tile.resizeEndTimer = setTimeout(() => {
      tile.resizeUndoPushed = false;
    }, 400);
    scheduleSaveState();
  });
  tile.resizeObserver.observe(tile.el);
}

function tileMinSize(tile) {
  if (tile.isTwitch) {
    return { w: TWITCH_TILE_MIN_W, h: TWITCH_TILE_MIN_H };
  }
  return { w: TILE_MIN_W, h: TILE_MIN_H };
}

function findTileAtPoint(clientX, clientY, { videoOnly = false } = {}) {
  let best = null;
  let bestZ = -1;
  for (const tile of tiles.values()) {
    if (videoOnly && tile.isImage) continue;
    const bounds = tile.el.getBoundingClientRect();
    if (
      clientX < bounds.left ||
      clientX > bounds.right ||
      clientY < bounds.top ||
      clientY > bounds.bottom
    ) {
      continue;
    }
    const z = Number(tile.el.style.zIndex) || 0;
    if (z >= bestZ) {
      bestZ = z;
      best = tile;
    }
  }
  return best;
}

function isWheelResizeBlockedTarget(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (isHistoryKeyTarget(el)) return true;
  return !!el.closest?.(
    "#titleBar, .titleBtn, .winBtn, .windowControls, .tileControls input, .twitchVolume"
  );
}

function resizeTileByWheel(e, tile) {
  const bounds = tile.el.getBoundingClientRect();
  if (
    e.clientX < bounds.left ||
    e.clientX > bounds.right ||
    e.clientY < bounds.top ||
    e.clientY > bounds.bottom
  ) {
    return false;
  }

  const w = tile.el.offsetWidth;
  const h = tile.el.offsetHeight;
  const factor = Math.pow(1 + TILE_WHEEL_SCALE, -e.deltaY);
  const min = tileMinSize(tile);
  const newW = Math.max(min.w, Math.round(w * factor));
  const newH = Math.max(min.h, Math.round(h * factor));
  if (newW === w && newH === h) return true;

  const anchorX = (e.clientX - bounds.left) / w;
  const anchorY = (e.clientY - bounds.top) / h;
  let left = tile.el.offsetLeft + (w - newW) * anchorX;
  let top = tile.el.offsetTop + (h - newH) * anchorY;

  if (tileAtPositionOverlapsTwitch(tile, left, top)) return true;

  applyTileRect(tile, {
    x: Math.round(left),
    y: Math.round(top),
    w: newW,
    h: newH,
  });
  return true;
}

function handleTileWheel(e) {
  if (isWheelResizeBlockedTarget(e.target)) return;
  const tile = findTileAtPoint(e.clientX, e.clientY);
  if (!tile) return;
  if (!resizeTileByWheel(e, tile)) return;
  selectTile(tile.id);
  e.preventDefault();
}

function initTileWheelResize() {
  canvas.addEventListener("wheel", handleTileWheel, { passive: false });
}

function tileSnapshot(tile, source = tile.parsed.url) {
  const rect = tileRectFromEl(tile);
  const snap = { source, rect };
  if (tile.isGif) snap.isGif = true;
  return snap;
}

function readSavedPayload() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function scheduleSaveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveStateAsync();
  }, 300);
}

function flushSaveState() {
  clearTimeout(saveTimer);
  return saveStateAsync();
}

async function resolvePersistableSource(tile) {
  const url = tile.parsed.url;
  if (!url) return null;
  if (url.startsWith("blob:")) {
    if (!tile.isImage) return null;
    if (!tile.persistedDataUrl) {
      tile.persistedDataUrl = await blobUrlToDataUrl(url);
    }
    return tile.persistedDataUrl;
  }
  return url;
}

async function saveStateAsync() {
  const items = [];
  for (const tile of tiles.values()) {
    let source;
    try {
      source = await resolvePersistableSource(tile);
    } catch {
      continue;
    }
    if (!source || source.startsWith("blob:")) continue;
    items.push(tileSnapshot(tile, source));
  }
  const payload = { tiles: items };
  if (sessionLayoutMode) {
    payload.layout = sessionLayoutMode;
  }
  if (hasTauriWindow()) {
    payload.window = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Could not save session:", err);
    if (items.some((item) => item.source?.startsWith("data:image/"))) {
      showToast("Session save failed — image may be too large for storage");
    }
  }
}

async function restoreSavedWindowSize() {
  const data = readSavedPayload();
  const w = data?.window?.width;
  const h = data?.window?.height;
  if (!w || !h) return;
  if (!hasTauriWindow()) {
    return;
  }
  try {
    const maximized = await tauriInvoke("plugin:window|is_maximized", {
      label: WINDOW_LABEL,
    });
    if (maximized) {
      await tauriInvoke("plugin:window|toggle_maximize", { label: WINDOW_LABEL });
    }
    await tauriInvoke("plugin:window|set_size", {
      label: WINDOW_LABEL,
      value: {
        Logical: {
          width: Math.max(320, Math.round(w)),
          height: Math.max(180, Math.round(h)),
        },
      },
    });
  } catch (err) {
    console.warn("Could not restore window size:", err);
  }
}

function initWindowSizePersistence() {
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!hasTauriWindow()) {
      return;
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => scheduleSaveState(), 300);
  });
  window.addEventListener("pagehide", flushSaveState);
}

function getTilesBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const tile of tiles.values()) {
    const x = tile.el.offsetLeft;
    const y = tile.el.offsetTop;
    const w = tile.el.offsetWidth;
    const h = tile.el.offsetHeight;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return { minX, minY, maxX, maxY };
}

async function fitContentToTiles() {
  if (tiles.size === 0) {
    showToast("Add a video first");
    return;
  }
  clearSessionLayoutMode();
  pushUndoSnapshot();
  shiftTilesToFitPadding();
  await setWindowToTileBounds("Fit Content");
  flushSaveState();
}

async function optimalAlignToTiles() {
  if (tiles.size === 0) {
    showToast("Add a video first");
    return;
  }
  clearSessionLayoutMode();
  pushUndoSnapshot();
  for (const item of computeOptimalTileLayout()) {
    applyTileRect(item.tile, item.rect);
  }
  shiftTilesToFitPadding();
  await setWindowToTileBounds("Optimal Align");
  flushSaveState();
}

function sortTilesByPosition(tileList) {
  return [...tileList].sort((a, b) => {
    const ra = tileRectFromEl(a);
    const rb = tileRectFromEl(b);
    return ra.y - rb.y || ra.x - rb.x || a.id.localeCompare(b.id);
  });
}

function fourTilesGridCell(slotIndex, cellW, cellH) {
  const col = slotIndex % GRID_COLS;
  const row = Math.floor(slotIndex / GRID_COLS);
  const minY = minTileTop();
  return {
    x: col * cellW,
    y: minY + row * cellH,
    w: cellW,
    h: cellH,
  };
}

function computeFourTilesLayout() {
  const videoTiles = sortTilesByPosition(
    [...tiles.values()].filter((tile) => !tile.isImage)
  );
  const imageTiles = sortTilesByPosition(
    [...tiles.values()].filter((tile) => tile.isImage)
  );
  if (videoTiles.length === 0 && imageTiles.length === 0) {
    return null;
  }

  const minY = minTileTop();
  const cellW = Math.max(1, Math.floor(canvas.clientWidth / GRID_COLS));
  const cellH = Math.max(1, Math.floor((canvas.clientHeight - minY) / GRID_ROWS));

  const placements = [];
  const videosInGrid = videoTiles.slice(0, GRID_SLOTS);
  for (let slot = 0; slot < videosInGrid.length; slot++) {
    placements.push({ tile: videosInGrid[slot], ...fourTilesGridCell(slot, cellW, cellH) });
  }

  const videoSlotCount = videosInGrid.length;
  if (videoSlotCount === GRID_SLOTS && imageTiles.length > 0) {
    const cell = fourTilesGridCell(GRID_SLOTS - 1, cellW, cellH);
    for (const tile of imageTiles) {
      placements.push({ tile, ...cell });
    }
  } else if (videoSlotCount < GRID_SLOTS && imageTiles.length > 0) {
    const freeSlots = [];
    for (let slot = videoSlotCount; slot < GRID_SLOTS; slot++) {
      freeSlots.push(slot);
    }
    const perSlot = Math.floor(imageTiles.length / freeSlots.length);
    const remainder = imageTiles.length % freeSlots.length;
    let imageIndex = 0;
    for (let i = 0; i < freeSlots.length; i++) {
      const count = perSlot + (i < remainder ? 1 : 0);
      const cell = fourTilesGridCell(freeSlots[i], cellW, cellH);
      for (let j = 0; j < count; j++) {
        placements.push({ tile: imageTiles[imageIndex++], ...cell });
      }
    }
  }

  return { placements };
}

function pauseTileAfterLayout(tile) {
  if (tile.isImage) return;
  if (tile.isGif) {
    if (!tile.gifPaused) tile.toggleGifPlay?.();
    return;
  }
  if (tile.hasCustomControls) {
    const video = tile.body?.querySelector("video");
    if (video) video.pause();
    tile.syncControls?.();
    return;
  }
  if (tile.isTwitch && tile.twitchPlayer) {
    try {
      tile.twitchPlayer.pause();
    } catch {
      /* ignore Twitch embed errors */
    }
    tile.twitchUserPaused = false;
    tile.setTwitchPlaying(false);
    return;
  }
  if (tile.isYoutube && tile.ytFrame?.src) {
    try {
      const url = new URL(tile.ytFrame.src);
      if (url.searchParams.get("autoplay") === "1") {
        url.searchParams.set("autoplay", "0");
        tile.ytFrame.src = url.toString();
      }
    } catch {
      /* ignore URL parse errors */
    }
  }
}

function applyFourTilesLayout({ pushUndo = false, pausePlayback = true, save = true } = {}) {
  if (tiles.size === 0) return false;
  const layout = computeFourTilesLayout();
  if (!layout) return false;
  if (pushUndo) pushUndoSnapshot();

  const overlapGroups = new Map();
  for (const { tile, x, y, w, h } of layout.placements) {
    tile.preserveTileSize = true;
    applyTileRect(tile, { x, y, w, h });
    if (pausePlayback) pauseTileAfterLayout(tile);
    const key = `${x},${y}`;
    if (!overlapGroups.has(key)) overlapGroups.set(key, []);
    overlapGroups.get(key).push(tile);
  }
  for (const group of overlapGroups.values()) {
    if (group.length > 1) {
      for (const tile of group) {
        bringTileToFront(tile);
      }
    }
  }

  sessionLayoutMode = "four-tiles";
  if (save) {
    void flushSaveStateAfterLayout();
  }
  return true;
}

function layoutFourTiles() {
  if (tiles.size === 0) {
    showToast("Add a tile first");
    return;
  }
  applyFourTilesLayout({ pushUndo: true, pausePlayback: true, save: true });
}

async function flushSaveStateAfterLayout() {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return saveStateAsync();
}

function waitForTwitchApi() {
  if (window.Twitch?.Player) return Promise.resolve();
  if (twitchApiPromise) return twitchApiPromise;
  twitchApiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const deadline = setTimeout(() => {
      reject(new Error("Twitch API timeout"));
    }, 20000);
    script.src = "https://player.twitch.tv/js/embed/v1.js";
    script.async = true;
    script.onload = () => {
      if (window.Twitch?.Player) {
        clearTimeout(deadline);
        resolve();
        return;
      }
      reject(new Error("Twitch API unavailable"));
    };
    script.onerror = () => {
      clearTimeout(deadline);
      reject(new Error("Twitch API failed to load"));
    };
    document.head.appendChild(script);
  });
  twitchApiPromise = twitchApiPromise.catch((err) => {
    twitchApiPromise = null;
    throw err;
  });
  return twitchApiPromise;
}

async function loadSavedTiles() {
  await new Promise((resolve) => {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", resolve, { once: true });
  });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );

  await restoreSavedWindowSize();
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );

  const data = readSavedPayload();
  if (!data) return;
  sessionLayoutMode = data.layout === "four-tiles" ? "four-tiles" : null;

  for (const item of data.tiles || []) {
    if (!item?.source) continue;
    const parsed = parsedFromSavedItem(item);
    if (parsed.kind === "unknown") continue;
    const rect = item.rect || nextTileRect();
    await addTile(parsed, rect, {
      autostart: false,
      skipHistory: true,
      preservePlacement: sessionLayoutMode !== "four-tiles",
      preserveTileSize: !!(rect.w && rect.h),
      deferTwitchMount: parsed.kind === "twitch",
      deferYoutubeMount: parsed.kind === "youtube",
    });
  }

  if (sessionLayoutMode === "four-tiles") {
    applyFourTilesLayout({ pushUndo: false, pausePlayback: false, save: false });
  }

  syncAllTileZIndex();
  flushSaveState();
}

function initTitleBarVisibility() {
  if (!titleBar) return;
  let hideTimer = 0;
  const show = () => {
    clearTimeout(hideTimer);
    titleBar.classList.remove("is-hidden");
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => titleBar.classList.add("is-hidden"), 280);
  };
  document.addEventListener("mousemove", (e) => {
    if (e.clientY < TITLE_BAR_HEIGHT) show();
    else if (!e.target.closest?.("#titleBar")) scheduleHide();
  });
  titleBar.addEventListener("mouseenter", show);
  titleBar.addEventListener("mouseleave", scheduleHide);
}

function isInTitleBarBand(clientY) {
  const canvasRect = canvas.getBoundingClientRect();
  return clientY - canvasRect.top < TITLE_BAR_HEIGHT;
}

/** @returns {keyof RESIZE_CURSORS | null} */
function getWindowResizeHit(clientX, clientY) {
  const m = WINDOW_RESIZE_MARGIN;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const left = clientX < m;
  const right = clientX > w - m;
  const top = clientY < m;
  const bottom = clientY > h - m;
  const inTitleBar = clientY < TITLE_BAR_HEIGHT;

  // Title bar row: no top/right edge resize (close, minimize, maximize, Fit Content).
  if (inTitleBar) {
    if (left && top) return "NorthWest";
    return null;
  }

  if (left && top) return "NorthWest";
  if (right && bottom) return "SouthEast";
  if (left && bottom) return "SouthWest";
  if (bottom) return "South";
  if (left) return "West";
  if (right) return "East";
  return null;
}

function isTileResizeCorner(clientX, clientY) {
  for (const tile of tiles.values()) {
    const r = tile.el.getBoundingClientRect();
    if (
      clientX >= r.right - TILE_RESIZE_CORNER &&
      clientY >= r.bottom - TILE_RESIZE_CORNER
    ) {
      return true;
    }
  }
  return false;
}

function isTitleBarControl(el) {
  return !!el?.closest?.(".titleBtn, .winBtn, .windowControls");
}

function clearTopBarCursor() {
  document.body.style.cursor = "";
}

function shouldShowTopBarGrab(clientX, clientY) {
  if (!isInTitleBarBand(clientY)) return false;
  if (getWindowResizeHit(clientX, clientY)) return false;
  if (isTileResizeCorner(clientX, clientY)) return false;
  const el = document.elementFromPoint(clientX, clientY);
  if (isTitleBarControl(el)) return false;
  if (el?.closest?.(".tile, .tileDragHandle, .tileDeleteBtn, .tileControls")) {
    return false;
  }
  return true;
}

function updateTopBarCursor(e) {
  const resizeDir = getWindowResizeHit(e.clientX, e.clientY);
  if (resizeDir) {
    document.body.style.cursor = RESIZE_CURSORS[resizeDir];
    return;
  }
  if (shouldShowTopBarGrab(e.clientX, e.clientY)) {
    document.body.style.cursor = "grab";
    return;
  }
  clearTopBarCursor();
}

function tryStartWindowResize(e) {
  if (e.button !== 0) return false;
  if (isTitleBarControl(e.target)) return false;
  const dir = getWindowResizeHit(e.clientX, e.clientY);
  if (!dir) return false;
  if (!hasTauriWindow()) return false;
  tauriInvoke("plugin:window|start_resize_dragging", {
    label: WINDOW_LABEL,
    value: dir,
  }).catch(() => {});
  return true;
}

function tryStartWindowDrag(e) {
  if (e.button !== 0) return false;
  if (!shouldShowTopBarGrab(e.clientX, e.clientY)) return false;
  if (hasTauriWindow()) {
    document.body.style.cursor = "grabbing";
    const endGrab = () => {
      clearTopBarCursor();
      document.removeEventListener("pointerup", endGrab);
      document.removeEventListener("pointercancel", endGrab);
    };
    document.addEventListener("pointerup", endGrab);
    document.addEventListener("pointercancel", endGrab);
    tauriInvoke("plugin:window|start_dragging", { label: WINDOW_LABEL }).catch(
      () => {}
    );
  }
  return true;
}

function twitchParentDomains() {
  const domains = new Set(["localhost", "127.0.0.1", "tauri.localhost"]);
  const host = window.location.hostname;
  if (host) domains.add(host);
  try {
    const u = new URL(window.location.href);
    if (u.hostname) domains.add(u.hostname);
  } catch {
    /* ignore */
  }
  return [...domains];
}

function initTopBarDragZone() {
  document.addEventListener("mousemove", updateTopBarCursor);
  document.addEventListener("mouseleave", clearTopBarCursor);
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!tryStartWindowResize(e)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}

async function addTile(
  parsed,
  rect,
  {
    id: presetId = null,
    autostart = true,
    skipHistory = false,
    deferTwitchMount = false,
    deferYoutubeMount = false,
    preservePlacement = false,
    preserveTileSize = false,
  } = {}
) {
  if (parsed.kind !== "image" && videoTileCount() >= MAX_VIDEO_TILES) {
    showToast(`Maximum ${MAX_VIDEO_TILES} videos — remove one first`);
    return;
  }
  if (!skipHistory) pushUndoSnapshot();
  emptyState.classList.add("hidden");
  const id = presetId || crypto.randomUUID();
  if (tiles.has(id)) {
    tiles.get(id)?.destroy();
    tiles.delete(id);
  }
  const rawRect = clampRectBelowTitleBar(rect || nextTileRect());
  const placement = preservePlacement
    ? rawRect
    : findRectAvoidingTwitch(rawRect, presetId);
  const tile = new Tile(id, parsed, placement, {
    autostart,
    deferTwitchMount,
    deferYoutubeMount,
  });
  tile.preserveTileSize = preserveTileSize;
  if (parsed.url?.startsWith("blob:")) tile.blobUrl = parsed.url;
  tiles.set(id, tile);
  canvas.appendChild(tile.el);
  bringTileToFront(tile);
  enableTileDrag(tile, id);
  observeTileResize(tile);
  tile.el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target === tile.dragHandle || e.target === tile.dragHandleBottom) return;
    if (
      tile.isTwitch &&
      e.target.closest?.(".twitchControls, .twitchCloseBtn")
    ) {
      return;
    }
    if (tile.isGif && e.target.closest?.(".gifControls, .gifCloseBtn")) {
      return;
    }
    selectTile(id);
    e.stopPropagation();
  });
  try {
    await tile.mount();
    tile.historyReady = true;
    selectTile(id);
    scheduleSaveState();
  } catch (err) {
    tile.destroy();
    tiles.delete(id);
    showToast(String(err.message || err));
    if (tiles.size === 0) emptyState.classList.remove("hidden");
  }
}

async function addFromText(text) {
  const parsed = parseMediaInput(text);
  if (parsed.kind === "unknown") {
    showToast(`Unsupported: ${text.slice(0, 60)}`);
    return;
  }
  await addTile(parsed);
}

async function addFromBlob(file) {
  const isImage =
    file.type.startsWith("image/") || isImageExtension(file.name);
  const kind = isImage ? "image" : "video";
  if (kind === "video" && !isVideoExtension(file.name) && !file.type.startsWith("video/")) {
    showToast(`Unsupported file: ${file.name}`);
    return;
  }
  const isGif = isImage && (file.type === "image/gif" || isGifSource(file.name));
  if (isImage) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await addTile({ kind: "image", url: dataUrl, isGif });
      return;
    } catch {
      showToast(`Could not import image: ${file.name}`);
      return;
    }
  }
  const url = URL.createObjectURL(file);
  await addTile({ kind: "video", url });
}

async function addFromPaths(paths) {
  for (const path of paths) {
    if (isVideoExtension(path) || isImageExtension(path)) await addFromText(path);
  }
}

function extractDropText(dataTransfer) {
  const plain = dataTransfer.getData("text/plain")?.trim();
  if (plain) return plain.split(/\r?\n/)[0].trim();
  const uri = dataTransfer.getData("text/uri-list")?.trim();
  if (uri) return uri.split(/\r?\n/)[0].trim();
  const html = dataTransfer.getData("text/html")?.trim();
  if (html) {
    const match = html.match(/https?:\/\/[^\s"'<>]+/i);
    if (match) return match[0];
  }
  return "";
}

function selectTile(id) {
  for (const t of tiles.values()) t.deselect();
  const tile = tiles.get(id);
  tile?.select();
  if (tile) bringTileToFront(tile);
  canvas.focus();
}

function deleteTile(id, { skipHistory = false } = {}) {
  const tile = tiles.get(id);
  if (!tile) return;
  if (!skipHistory) pushUndoSnapshot();
  tile.destroy();
  tiles.delete(id);
  if (selectedId === id) selectedId = null;
  if (tiles.size === 0) emptyState.classList.remove("hidden");
  scheduleSaveState();
}

function deleteSelectedTile() {
  if (selectedId) deleteTile(selectedId);
}

function destroyAllTilesBeforeClose() {
  for (const id of [...tiles.keys()]) {
    tiles.get(id)?.destroy();
    tiles.delete(id);
  }
  selectedId = null;
}

async function prepareForShutdown() {
  await flushSaveState();
  destroyAllTilesBeforeClose();
}

async function closeAppWindow() {
  if (!hasTauriWindow()) {
    window.close();
    return;
  }
  const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
  if (typeof getCurrentWindow === "function") {
    await getCurrentWindow().close();
    return;
  }
  await tauriInvoke("plugin:window|close", { label: WINDOW_LABEL });
}

async function runShutdownAndClose() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await prepareForShutdown();
    await closeAppWindow();
  } catch (err) {
    shuttingDown = false;
    console.error("Failed to close:", err);
    throw err;
  }
}

async function quitProgram() {
  await runShutdownAndClose().catch(() => {});
}

async function initCloseHandling() {
  if (!hasTauriWindow()) return;
  const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
  if (typeof getCurrentWindow !== "function") return;
  try {
    const appWindow = getCurrentWindow();
    await appWindow.onCloseRequested(async (event) => {
      if (shuttingDown) return;
      event.preventDefault();
      await runShutdownAndClose().catch(() => {});
    });
  } catch (err) {
    console.warn("Could not register close handler:", err);
  }
}

let canvasContextMenu = null;
let contextMenuVideoTileId = null;

function hideCanvasContextMenu() {
  canvasContextMenu?.classList.add("hidden");
  contextMenuVideoTileId = null;
}

function updateCanvasContextMenu(clientX, clientY) {
  const closeBtn = canvasContextMenu?.querySelector('[data-action="close-video"]');
  const tile = findTileAtPoint(clientX, clientY, { videoOnly: true });
  contextMenuVideoTileId = tile?.id ?? null;
  if (closeBtn) {
    closeBtn.disabled = !tile;
  }
}

function showCanvasContextMenu(clientX, clientY) {
  if (!canvasContextMenu) return;
  updateCanvasContextMenu(clientX, clientY);
  canvasContextMenu.classList.remove("hidden");
  canvasContextMenu.style.left = `${clientX}px`;
  canvasContextMenu.style.top = `${clientY}px`;
  requestAnimationFrame(() => {
    const menu = canvasContextMenu;
    if (!menu) return;
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    let x = clientX;
    let y = clientY;
    if (rect.right > window.innerWidth - pad) {
      x = window.innerWidth - rect.width - pad;
    }
    if (rect.bottom > window.innerHeight - pad) {
      y = window.innerHeight - rect.height - pad;
    }
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
}

async function syncMaximizeButtonIcon() {
  const btnMaximize = document.getElementById("btnMaximize");
  if (!btnMaximize || !hasTauriWindow()) return;
  try {
    const maximized = await tauriInvoke("plugin:window|is_maximized", {
      label: WINDOW_LABEL,
    });
    btnMaximize.textContent = maximized ? "❐" : "□";
    btnMaximize.title = maximized ? "Restore" : "Maximize";
  } catch {
    /* ignore */
  }
}

async function minimizeWindow() {
  if (!hasTauriWindow()) {
    showToast("Minimize only works in the StickOnVid desktop app");
    return;
  }
  await tauriInvoke("plugin:window|minimize", { label: WINDOW_LABEL }).catch(console.error);
}

async function toggleMaximizeWindow() {
  if (!hasTauriWindow()) {
    showToast("Maximize only works in the StickOnVid desktop app");
    return;
  }
  try {
    await tauriInvoke("plugin:window|toggle_maximize", { label: WINDOW_LABEL });
    await syncMaximizeButtonIcon();
  } catch (err) {
    console.error(err);
  }
}

function initCanvasContextMenu() {
  canvasContextMenu = document.createElement("div");
  canvasContextMenu.id = "canvasContextMenu";
  canvasContextMenu.className = "canvasContextMenu hidden";
  canvasContextMenu.innerHTML = `
    <button type="button" data-action="fit">Fit Content<span class="ctxShortcut">Ctrl+F</span></button>
    <button type="button" data-action="align">Optimal Align<span class="ctxShortcut">Ctrl+O</span></button>
    <button type="button" data-action="four-tiles">4-Tiles<span class="ctxShortcut">Ctrl+T</span></button>
    <button type="button" data-action="close-video" disabled>Close Video</button>
    <button type="button" data-action="minimize">Minimize Window</button>
    <button type="button" data-action="maximize">Maximize Window</button>
    <div class="ctxSeparator" role="separator"></div>
    <button type="button" data-action="quit">Quit Program</button>
  `;
  document.body.appendChild(canvasContextMenu);

  canvasContextMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const videoId = contextMenuVideoTileId;
    hideCanvasContextMenu();
    if (action === "fit") fitContentToTiles();
    else if (action === "align") optimalAlignToTiles();
    else if (action === "four-tiles") layoutFourTiles();
    else if (action === "close-video") {
      if (videoId) deleteTile(videoId);
    } else if (action === "minimize") void minimizeWindow();
    else if (action === "maximize") void toggleMaximizeWindow();
    else if (action === "quit") void quitProgram();
  });

  canvas.addEventListener("contextmenu", (e) => {
    if (e.target.closest?.("#titleBar")) return;
    e.preventDefault();
    showCanvasContextMenu(e.clientX, e.clientY);
  });

  document.addEventListener("pointerdown", (e) => {
    if (!canvasContextMenu || canvasContextMenu.classList.contains("hidden")) return;
    if (e.target.closest?.("#canvasContextMenu")) return;
    hideCanvasContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCanvasContextMenu();
  });
}

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3200);
}

document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (items) {
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addFromBlob(file);
        return;
      }
    }
  }
  const text = e.clipboardData?.getData("text/plain")?.trim();
  if (text) {
    e.preventDefault();
    addFromText(text);
  }
});

function clearTileSelection() {
  for (const t of tiles.values()) t.deselect();
  selectedId = null;
}

function initWindowFocusHandling() {
  window.addEventListener("blur", clearTileSelection);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") clearTileSelection();
  });
}

initWindowFocusHandling();

document.addEventListener("keydown", (e) => {
  if (isHistoryKeyTarget(e.target)) return;
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    fitContentToTiles();
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    optimalAlignToTiles();
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    layoutFourTiles();
    return;
  }
  if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if (e.ctrlKey && e.key === "z" && e.shiftKey) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.key === "Delete") {
    if (!document.hasFocus() || !selectedId) return;
    e.preventDefault();
    deleteSelectedTile();
  }
  if (e.key === " " || e.code === "Space") {
    if (!document.hasFocus()) return;
    const tile = selectedId ? tiles.get(selectedId) : null;
    if (tile?.isYoutube && tile.youtubeDeferred) {
      e.preventDefault();
      tile.loadDeferredYoutube();
      return;
    }
    if (tile?.isTwitch && tile.twitchPlayer) {
      e.preventDefault();
      tile.toggleTwitchPlay();
      return;
    }
    if (tile?.isGif) {
      e.preventDefault();
      tile.toggleGifPlay();
    }
  }
});

canvas.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

canvas.addEventListener("drop", async (e) => {
  e.preventDefault();
  const text = extractDropText(e.dataTransfer);
  if (text) {
    await addFromText(text);
    return;
  }
  for (const file of e.dataTransfer.files) {
    if (
      isVideoExtension(file.name) ||
      isImageExtension(file.name) ||
      file.type.startsWith("video/") ||
      file.type.startsWith("image/")
    ) {
      await addFromBlob(file);
    }
  }
});

canvas.addEventListener("pointerdown", (e) => {
  if (tryStartWindowResize(e) || tryStartWindowDrag(e)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.target !== canvas && e.target !== emptyState) return;
  for (const t of tiles.values()) t.deselect();
  selectedId = null;
});

tauriListen("tauri://drag-drop", (event) => {
  const paths = event.payload?.paths;
  if (Array.isArray(paths)) addFromPaths(paths);
}).catch(() => {});

initTitleBarVisibility();
initTopBarDragZone();
initWindowControls();
initTileWheelResize();
initCanvasContextMenu();
initWindowSizePersistence();
void initCloseHandling();
document.getElementById("btnFitContent")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  fitContentToTiles();
});
loadSavedTiles();

function initWindowControls() {
  const btnMinimize = document.getElementById("btnMinimize");
  const btnMaximize = document.getElementById("btnMaximize");
  const btnClose = document.getElementById("btnClose");

  if (!hasTauriWindow()) {
    return;
  }

  btnMinimize?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void minimizeWindow();
  });
  btnMaximize?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await toggleMaximizeWindow();
  });
  const closeWindow = () => {
    void quitProgram();
  };
  btnClose?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeWindow();
  });
  btnClose?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  syncMaximizeButtonIcon();
}
