const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

const bg = $("bg");
const player = $("player");
const input = $("search-input");
const statusEl = $("status");
const resultsLabel = $("results-label");
const results = $("results");
const recentEl = $("recent");
const chartsEl = $("charts");
const chipsEl = $("chips");
const homeStatus = $("home-status");
const relList = $("related");
const relLabel = $("related-label");
const npEmpty = $("np-empty");
const npContent = $("np-content");
const bigArt = $("np-big");
const bigTitle = $("np-big-title");
const bigArtist = $("np-big-artist");
const seek = $("seek");
const tCur = $("t-cur");
const tDur = $("t-dur");
const pinBtn = $("pin");

const HINT = "Search for tracks, artists and mixes";
const GENRES = [
  ["all-music", "All music"],
  ["hiphoprap", "Hip-hop & Rap"],
  ["electronic", "Electronic"],
  ["pop", "Pop"],
  ["rock", "Rock"],
  ["ambient", "Ambient"],
];

const tiny = (u) => u.replace("-t300x300", "-t67x67"); // cheap, stretched = soft
const big = (u) => u.replace("-t300x300", "-t500x500");

function fmt(sec) {
  if (!sec || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* ---------- window: drag, double-click, buttons ---------- */
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("button, input")) return;
  if (e.target.closest("[data-drag]")) invoke("start_drag");
});
document.addEventListener("dblclick", (e) => {
  if (e.target.closest("button, input")) return;
  if (e.target.closest("[data-drag]")) invoke("win_toggle_max");
});
$("w-min").addEventListener("click", () => invoke("win_minimize"));
$("w-max").addEventListener("click", () => invoke("win_toggle_max"));
$("w-close").addEventListener("click", () => invoke("win_close"));

/* ---------- settings ---------- */
const DEFAULTS = {
  color: true,
  bgMode: "follow",
  light: false,
  pinned: null,
  bgColor: { h: 235, s: 0.12, v: 0.14 },
};
let settings = { ...DEFAULTS, ...store.get("aq-settings", {}) };
settings.bgColor = { ...DEFAULTS.bgColor, ...settings.bgColor };
let currentArt = null; // artwork of the playing track
let current = null; // the playing track

function setSwitch(btn, on) {
  btn.setAttribute("aria-checked", String(on));
}

function updateBackground() {
  let src = null;
  if (settings.bgMode === "pinned" && settings.pinned) src = settings.pinned.art;
  else if (settings.bgMode !== "off") src = currentArt;
  // Lightweight mode uses a tiny stretched image with no CSS blur (much cheaper)
  const url = src ? (settings.light ? tiny(src) : src) : null;
  bg.style.backgroundImage = url ? `url("${url}")` : "none";
}

function isPinnedNow() {
  return !!(
    settings.pinned &&
    settings.bgMode === "pinned" &&
    current &&
    settings.pinned.art === current.artwork
  );
}

function updatePinButton() {
  const on = isPinnedNow();
  pinBtn.classList.toggle("on", on);
  pinBtn.title = on ? "Unpin background" : "Pin this artwork as the background";
}

function hsv2hex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty("--art-filter", settings.color ? "none" : "grayscale(1)");
  root.dataset.light = String(settings.light);

  setSwitch($("set-color"), settings.color);
  setSwitch($("set-light"), settings.light);
  document.querySelectorAll("#set-bgmode button").forEach((b) =>
    b.classList.toggle("on", b.dataset.v === settings.bgMode)
  );

  // solid color (only used when Background = Off)
  const c = settings.bgColor;
  const hex = hsv2hex(c.h, c.s, c.v);
  if (settings.bgMode === "off") root.style.setProperty("--bg-color", hex);
  else root.style.removeProperty("--bg-color");
  $("color-row").hidden = settings.bgMode !== "off";
  $("color-hex").textContent = hex.toUpperCase();
  const rad = (c.h * Math.PI) / 180;
  const dot = $("wheel-dot");
  dot.style.left = `${50 + c.s * 50 * Math.sin(rad)}%`;
  dot.style.top = `${50 - c.s * 50 * Math.cos(rad)}%`;
  dot.style.background = hex;
  $("wheel").style.setProperty("--dim", String(1 - c.v));
  $("wheel-v").value = Math.round(c.v * 100);
  $("wheel-v").style.setProperty("--p", `${Math.round(c.v * 100)}%`);

  const p = settings.pinned;
  $("pin-art").hidden = !p;
  if (p) $("pin-art").src = p.art;
  $("pin-title").textContent = p ? p.title : "Nothing pinned";
  $("pin-desc").textContent = p
    ? "This artwork stays behind the player whatever is playing."
    : "Use the pin button in the player to keep a track's artwork as your background.";
  $("unpin").hidden = !p;

  updateBackground();
  updatePinButton();
}

$("set-color").addEventListener("click", () => {
  settings.color = !settings.color;
  store.set("aq-settings", settings);
  applySettings();
});
$("set-light").addEventListener("click", () => {
  settings.light = !settings.light;
  store.set("aq-settings", settings);
  applySettings();
});
$("set-bgmode").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.v === "pinned" && !settings.pinned) {
    toast("Pin an artwork first with the pin button in the player");
    return;
  }
  settings.bgMode = b.dataset.v;
  store.set("aq-settings", settings);
  applySettings();
});
$("unpin").addEventListener("click", () => {
  settings.pinned = null;
  if (settings.bgMode === "pinned") settings.bgMode = "follow";
  store.set("aq-settings", settings);
  applySettings();
});
pinBtn.addEventListener("click", () => {
  if (isPinnedNow()) {
    settings.pinned = null;
    settings.bgMode = "follow";
  } else {
    if (!current?.artwork) return toast("This track has no artwork to pin");
    settings.pinned = { art: current.artwork, title: current.title };
    settings.bgMode = "pinned";
  }
  store.set("aq-settings", settings);
  applySettings();
});

/* color wheel (hue = angle, saturation = distance from center) */
const wheel = $("wheel");
function pickFromEvent(e) {
  const r = wheel.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  settings.bgColor.h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  settings.bgColor.s = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
  applySettings();
}
wheel.addEventListener("pointerdown", (e) => {
  wheel.setPointerCapture(e.pointerId);
  pickFromEvent(e);
});
wheel.addEventListener("pointermove", (e) => {
  if (wheel.hasPointerCapture(e.pointerId)) pickFromEvent(e);
});
wheel.addEventListener("pointerup", () => store.set("aq-settings", settings));
$("wheel-v").addEventListener("input", (e) => {
  settings.bgColor.v = Number(e.target.value) / 100;
  applySettings();
});
$("wheel-v").addEventListener("change", () => store.set("aq-settings", settings));

/* ---------- views ---------- */
let chartsLoaded = false;

function showView(name) {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "search") input.focus();
  if (name === "home" && !chartsLoaded) loadCharts();
}
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view))
);
$("login-btn").addEventListener("click", () => {
  $("login-note").textContent = "Login arrives in the next step.";
});

/* ---------- building lists ---------- */
function playFrom(list, i) {
  queue = list.slice();
  playAt(i);
}

function row(t, list, i, compact) {
  const li = make("li", compact ? "track compact" : "track");
  li.dataset.id = t.id;
  const img = make("img", "art");
  img.alt = "";
  img.loading = "lazy";
  if (t.artwork) img.src = t.artwork;
  const info = make("div", "info");
  info.append(make("div", "title", t.title), make("div", "artist", t.artist));
  li.append(img, info);
  if (!compact) li.append(make("div", "time", t.duration ? fmt(t.duration) : ""));
  li.addEventListener("click", () => playFrom(list, i));
  return li;
}

function card(t, list, i) {
  const c = make("div", "card");
  c.dataset.id = t.id;
  const img = make("img", "cover");
  img.alt = "";
  img.loading = "lazy";
  if (t.artwork) img.src = t.artwork;
  c.append(img, make("div", "title", t.title), make("div", "artist", t.artist));
  c.addEventListener("click", () => playFrom(list, i));
  return c;
}

function markActive() {
  const id = current ? String(current.id) : "";
  document.querySelectorAll("[data-id]").forEach((e) =>
    e.classList.toggle("active", e.dataset.id === id)
  );
}

/* ---------- home ---------- */
function greet() {
  const h = new Date().getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

let recents = store.get("aq-recent", []);
function pushRecent(t) {
  const slim = { id: t.id, title: t.title, artist: t.artist, artwork: t.artwork, duration: t.duration };
  recents = [slim, ...recents.filter((r) => r.id !== t.id)].slice(0, 12);
  store.set("aq-recent", recents);
  renderRecents();
}
function renderRecents() {
  $("recent-wrap").hidden = !recents.length;
  recentEl.replaceChildren(...recents.map((t, i) => card(t, recents, i)));
  markActive();
}

let chartKind = "trending";
let chartGenre = "all-music";
let chartSeq = 0;

function renderChips() {
  chipsEl.replaceChildren(
    ...GENRES.map(([id, label]) => {
      const b = make("button", id === chartGenre ? "chip on" : "chip", label);
      b.dataset.v = id;
      return b;
    })
  );
  document.querySelectorAll("#kind-seg button").forEach((b) =>
    b.classList.toggle("on", b.dataset.v === chartKind)
  );
}
chipsEl.addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  chartGenre = b.dataset.v;
  renderChips();
  loadCharts();
});
$("kind-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  chartKind = b.dataset.v;
  renderChips();
  loadCharts();
});

async function loadCharts() {
  const my = ++chartSeq;
  chartsEl.replaceChildren();
  homeStatus.textContent = "Loading charts…";
  try {
    const tracks = await invoke("charts", { kind: chartKind, genre: chartGenre });
    if (my !== chartSeq) return;
    chartsLoaded = true;
    homeStatus.textContent = tracks.length ? "" : "Nothing here right now";
    chartsEl.replaceChildren(...tracks.map((t, i) => card(t, tracks, i)));
    markActive();
  } catch (err) {
    if (my === chartSeq) homeStatus.textContent = String(err);
  }
}

/* ---------- playback ---------- */
let queue = [];
let index = -1;
let related = [];
let relSeq = 0;
let playing = false;
let started = false; // have we seen mpv come up for this track?
let loading = false;
let waited = 0;
let gen = 0; // bumps on every new track so stale polls are ignored
let dragging = false; // dragging the seek bar
let duration = 0;

function setPlaying(v) {
  playing = v;
  player.dataset.playing = String(v);
}

function updateSeek(pos) {
  const f = duration > 0 ? Math.min(1, pos / duration) : 0;
  seek.value = Math.round(f * 1000);
  seek.style.setProperty("--p", `${f * 100}%`);
  tCur.textContent = fmt(pos);
  tDur.textContent = fmt(duration);
}

function showNowPlaying(t) {
  bigTitle.textContent = t.title;
  bigArtist.textContent = t.artist;
  currentArt = t.artwork || null;

  if (t.artwork) {
    bigArt.onerror = () => {
      bigArt.onerror = null;
      bigArt.src = t.artwork;
    };
    bigArt.src = big(t.artwork);
    bigArt.hidden = false;
  } else {
    bigArt.hidden = true;
  }
  updateBackground();
  updatePinButton();
  npEmpty.hidden = true;
  npContent.hidden = false;
}

async function loadRelated(t) {
  const my = ++relSeq;
  related = [];
  relList.replaceChildren();
  relLabel.hidden = true;
  try {
    const list = await invoke("related", { id: t.id });
    if (my !== relSeq) return;
    related = list;
    relLabel.hidden = !list.length;
    relList.replaceChildren(...list.slice(0, 4).map((x, i) => row(x, list, i, true)));
    markActive();
  } catch {
    /* suggestions are optional */
  }
}

async function playAt(i) {
  let t = queue[i];
  if (!t) return;
  index = i;
  current = t;
  const my = ++gen;
  loading = true;
  started = false;
  waited = 0;
  duration = t.duration || 0;
  showNowPlaying(t);
  updateSeek(0);
  markActive();
  setPlaying(true);
  try {
    if (!t.streamApi) {
      // came from "recently played": fetch fresh stream info first
      t = await invoke("get_track", { id: t.id });
      if (my !== gen) return;
      queue[i] = t;
      current = t;
    }
    pushRecent(t);
    await invoke("play", { streamApi: t.streamApi, auth: t.auth });
    if (my === gen) loadRelated(t);
  } catch (err) {
    if (my === gen) {
      setPlaying(false);
      toast(String(err));
    }
  } finally {
    if (my === gen) loading = false;
  }
}

function nextTrack() {
  if (index + 1 < queue.length) {
    playAt(index + 1);
    return true;
  }
  if (related.length) {
    // out of queue: carry on with the suggestions
    queue = related.slice();
    playAt(0);
    return true;
  }
  return false;
}

async function tick() {
  if (index < 0 || loading || dragging) return;
  const my = gen;
  let s;
  try {
    s = await invoke("player_state");
  } catch {
    return;
  }
  if (my !== gen || loading) return;

  if (s.running) {
    started = true;
    setPlaying(!s.paused);
    if (s.duration > 0) duration = s.duration;
    updateSeek(s.position);
  } else if (started) {
    // mpv exited: the track finished, so move on
    started = false;
    if (!nextTrack()) {
      setPlaying(false);
      updateSeek(0);
    }
  } else if (playing && ++waited > 16) {
    setPlaying(false);
    toast("Couldn't play that track");
  }
}
setInterval(tick, 500);

/* ---------- controls ---------- */
$("toggle").addEventListener("click", async () => {
  try {
    await invoke("toggle_pause");
    setPlaying(!playing);
  } catch {
    // mpv is gone (track ended) - start the current track again
    if (index >= 0) playAt(index);
  }
});

$("next").addEventListener("click", () => nextTrack());

$("prev").addEventListener("click", () => {
  const cur = (seek.value / 1000) * duration;
  if (cur > 3 || index <= 0) invoke("seek", { seconds: 0 }).catch(() => {});
  else playAt(index - 1);
});

seek.addEventListener("input", () => {
  dragging = true;
  const f = seek.value / 1000;
  seek.style.setProperty("--p", `${f * 100}%`);
  tCur.textContent = fmt(f * duration);
});
seek.addEventListener("change", async () => {
  const f = seek.value / 1000;
  dragging = false;
  try {
    await invoke("seek", { seconds: f * duration });
  } catch {}
});

document.addEventListener("keydown", (e) => {
  const typing = document.activeElement === input;
  if (e.code === "Space" && !typing && index >= 0) {
    e.preventDefault();
    document.activeElement?.blur?.();
    $("toggle").click();
  } else if (e.key === "/" && !typing) {
    e.preventDefault();
    showView("search");
  }
});

/* ---------- search (live) ---------- */
let searchSeq = 0;
let lastQuery = "";
let debounce = null;

function resetSearch() {
  searchSeq++;
  lastQuery = "";
  results.replaceChildren();
  resultsLabel.hidden = true;
  statusEl.textContent = HINT;
}

async function runSearch(q) {
  const my = ++searchSeq;
  lastQuery = q;
  // keep the old results on screen while the new ones load
  statusEl.textContent = results.children.length ? "" : "Searching…";
  try {
    const tracks = await invoke("search", { query: q });
    if (my !== searchSeq) return; // a newer search took over
    statusEl.textContent = tracks.length ? "" : "No results";
    resultsLabel.hidden = !tracks.length;
    results.replaceChildren(...tracks.map((t, i) => row(t, tracks, i, false)));
    results.scrollTop = 0;
    markActive();
  } catch (err) {
    if (my !== searchSeq) return;
    statusEl.textContent = String(err);
  }
}

input.addEventListener("input", () => {
  clearTimeout(debounce);
  const q = input.value.trim();
  if (!q) return resetSearch();
  if (q.length < 2 || q === lastQuery) return;
  debounce = setTimeout(() => runSearch(q), 300);
});

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(debounce);
  const q = input.value.trim();
  if (q) runSearch(q);
});

/* ---------- start ---------- */
$("greeting").textContent = greet();
applySettings();
renderChips();
renderRecents();
showView("home");

