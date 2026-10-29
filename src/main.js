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
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
};

const bg = $("bg");
const player = $("player");
const input = $("search-input");
const statusEl = $("status");
const resultsLabel = $("results-label");
const results = $("results");
const recentEl = $("recent");
const likedWrap = $("liked-wrap");
const likedGrid = $("liked-grid");
const likedList = $("liked-list");
const likedStatus = $("liked-status");
const plWrap = $("playlists-wrap");
const plGrid = $("playlists-grid");
const plAll = $("pl-all");
const plEmpty = $("pl-empty");
const plList = $("pl-list");
const plStatus = $("pl-status");
const homeEmpty = $("home-empty");
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
const likeBtn = $("like");
const moreBtn = $("more");
const menuEl = $("menu");
const nameModal = $("name-modal");
const nameInput = $("name-input");

const HINT = "Search for tracks, artists and mixes";
const DOTS =
  '<svg class="fill" viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="18.5" cy="12" r="1.8" /></svg>';

const tiny = (u) => u.replace("-t300x300", "-t67x67"); // cheap, stretched = soft
const big = (u) => u.replace("-t300x300", "-t500x500");
// the small version of a track we keep in local storage (stream info is fetched fresh on play)
const slim = (t) => ({ id: t.id, title: t.title, artist: t.artist, artwork: t.artwork, duration: t.duration });

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

/* ---------- no accidental zoom (zoom lives in Settings now) ---------- */
window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) e.preventDefault();
}, true);
document.addEventListener("gesturestart", (e) => e.preventDefault());

/* ---------- scrollbars only show while something is scrolling ---------- */
const scrollTimers = new WeakMap();
document.addEventListener(
  "scroll",
  (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    el.classList.add("scrolling");
    clearTimeout(scrollTimers.get(el));
    scrollTimers.set(el, setTimeout(() => el.classList.remove("scrolling"), 900));
  },
  true
);

/* ---------- settings ---------- */
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const DEFAULTS = {
  color: true,
  bgMode: "follow",
  light: false,
  pinned: null,
  zoom: 1,
  bgColor: { h: 235, s: 0.12, v: 0.14 },
};
let settings = { ...DEFAULTS, ...store.get("aq-settings", {}) };
settings.bgColor = { ...DEFAULTS.bgColor, ...settings.bgColor };
if (!ZOOMS.includes(settings.zoom)) settings.zoom = 1;
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

  // zoom label + stepper limits
  $("zoom-val").textContent = `${Math.round(settings.zoom * 100)}%`;
  $("zoom-out").disabled = settings.zoom <= ZOOMS[0];
  $("zoom-in").disabled = settings.zoom >= ZOOMS[ZOOMS.length - 1];

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
    : "Open the \u22EF menu in the player and choose Pin as background to keep a track's artwork.";
  $("unpin").hidden = !p;

  updateBackground();
}

// zoom is applied by the native webview (see set_zoom in lib.rs)
function applyZoom(report) {
  invoke("set_zoom", { factor: settings.zoom }).catch((err) => {
    if (report) toast(`Zoom failed: ${err}`);
  });
}
function setZoom(z) {
  settings.zoom = z;
  store.set("aq-settings", settings);
  applySettings();
  applyZoom(true);
}
function stepZoom(dir) {
  let i = ZOOMS.findIndex((z) => z >= settings.zoom - 0.001);
  if (i < 0) i = ZOOMS.length - 1;
  i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
  setZoom(ZOOMS[i]);
}
$("zoom-out").addEventListener("click", () => stepZoom(-1));
$("zoom-in").addEventListener("click", () => stepZoom(1));
$("zoom-val").addEventListener("click", () => setZoom(1));

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
    toast("Pin an artwork first from the \u22EF menu in the player");
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
function togglePin() {
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
}

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
function showView(name) {
  closeMenu();
  const navName = name === "playlist" ? "playlists" : name; // a playlist page lives under Playlists
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === navName)
  );
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "search") input.focus();
}
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view))
);
$("liked-all").addEventListener("click", () => showView("liked"));
$("playlists-all").addEventListener("click", () => showView("playlists"));

/* ---------- popup menu (⋯ button and right-click) ---------- */
let menuAnchor = null;
let menuPos = { x: 0, y: 0 };

function closeMenu() {
  menuEl.hidden = true;
  menuEl.replaceChildren();
  menuAnchor = null;
}

// items: { label, hint?, danger?, keep?, run } | { sep: true } | { title }
function openMenu(x, y, items, anchor = null) {
  menuEl.replaceChildren(
    ...items.map((it) => {
      if (it.sep) return make("div", "menu-sep");
      if (it.title) return make("div", "menu-title", it.title);
      const b = make("button", it.danger ? "menu-item danger" : "menu-item");
      b.append(make("span", "grow", it.label));
      if (it.hint) b.append(make("span", "hint", it.hint));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!it.keep) closeMenu();
        it.run();
      });
      return b;
    })
  );
  menuAnchor = anchor;
  menuEl.hidden = false;
  menuEl.style.left = "0px";
  menuEl.style.top = "0px";
  const r = menuEl.getBoundingClientRect();
  const nx = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  const ny = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  menuEl.style.left = `${nx}px`;
  menuEl.style.top = `${ny}px`;
  menuPos = { x: nx, y: ny };
}

document.addEventListener(
  "mousedown",
  (e) => {
    if (!menuEl.hidden && !e.target.closest("#menu, #more, .row-more")) closeMenu();
  },
  true
);
document.addEventListener(
  "scroll",
  (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
  },
  true
);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
menuEl.addEventListener("contextmenu", (e) => e.preventDefault());

function openPlaylistPicker(t) {
  const items = [{ title: "Add to playlist" }];
  playlists.forEach((pl) => {
    const has = pl.tracks.some((s) => s.id === t.id);
    items.push({ label: pl.name, hint: has ? "Added" : "", run: () => addToPlaylist(pl, t) });
  });
  if (playlists.length) items.push({ sep: true });
  items.push({
    label: "New playlist\u2026",
    run: () =>
      askName("New playlist", "Create", "", (name) => {
        const pl = createPlaylist(name);
        addToPlaylist(pl, t);
      }),
  });
  openMenu(menuPos.x, menuPos.y, items, menuAnchor);
}

function openTrackMenu(x, y, t, list, i, playlistId, anchor = null) {
  const items = [
    { label: "Play", run: () => playFrom(list, i) },
    {
      label: isLiked(t) ? "Remove from liked tracks" : "Add to liked tracks",
      run: () => toggleLikeFor(t),
    },
    { label: "Add to playlist\u2026", keep: true, run: () => openPlaylistPicker(t) },
  ];
  if (playlistId) {
    items.push(
      { sep: true },
      { label: "Remove from this playlist", danger: true, run: () => removeFromPlaylist(playlistId, t) }
    );
  }
  openMenu(x, y, items, anchor);
}

moreBtn.addEventListener("click", () => {
  if (!current) return;
  if (!menuEl.hidden && menuAnchor === moreBtn) return closeMenu();
  const t = current;
  const r = moreBtn.getBoundingClientRect();
  openMenu(
    r.left,
    r.bottom + 6,
    [
      { label: "Add to playlist\u2026", keep: true, run: () => openPlaylistPicker(t) },
      { label: isPinnedNow() ? "Unpin background" : "Pin as background", run: togglePin },
    ],
    moreBtn
  );
});

/* ---------- name dialog (new / rename playlist) ---------- */
let nameDone = null;
function askName(title, okLabel, initial, done) {
  closeMenu();
  $("name-title").textContent = title;
  $("name-ok").textContent = okLabel;
  nameInput.value = initial || "";
  nameDone = done;
  nameModal.hidden = false;
  nameInput.focus();
  nameInput.select();
}
function closeName() {
  nameModal.hidden = true;
  nameDone = null;
}
$("name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = nameInput.value.trim();
  if (!v) return;
  const cb = nameDone;
  closeName();
  if (cb) cb(v);
});
$("name-cancel").addEventListener("click", closeName);
nameModal.addEventListener("mousedown", (e) => {
  if (e.target === nameModal) closeName();
});

/* ---------- building lists ---------- */
function playFrom(list, i) {
  queue = list.slice();
  playAt(i);
}

function row(t, list, i, compact, playlistId) {
  const li = make("li", compact ? "track compact" : "track");
  li.dataset.id = t.id;
  const img = make("img", "art");
  img.alt = "";
  img.loading = "lazy";
  if (t.artwork) img.src = t.artwork;
  const info = make("div", "info");
  info.append(make("div", "title", t.title), make("div", "artist", t.artist));
  li.append(img, info);
  if (!compact) {
    li.append(make("div", "time", t.duration ? fmt(t.duration) : ""));
    const more = make("button", "row-more");
    more.setAttribute("aria-label", "More");
    more.innerHTML = DOTS;
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!menuEl.hidden && menuAnchor === more) return closeMenu();
      const r = more.getBoundingClientRect();
      openTrackMenu(r.left, r.bottom + 4, t, list, i, playlistId, more);
    });
    li.append(more);
  }
  li.addEventListener("click", () => playFrom(list, i));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openTrackMenu(e.clientX, e.clientY, t, list, i, playlistId);
  });
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
  c.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openTrackMenu(e.clientX, e.clientY, t, list, i, null);
  });
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

function updateHomeEmpty() {
  homeEmpty.textContent =
    !libraryChecked || recents.length || likes.length || playlists.length
      ? ""
      : "Search for a track and play it. Your recent and liked tracks will show up here.";
}

let recents = store.get("aq-recent", []);
function pushRecent(t) {
  recents = [slim(t), ...recents.filter((r) => r.id !== t.id)].slice(0, 12);
  store.set("aq-recent", recents);
  renderRecents();
}
function renderRecents() {
  $("recent-wrap").hidden = !recents.length;
  recentEl.replaceChildren(...recents.map((t, i) => card(t, recents, i)));
  updateHomeEmpty();
  markActive();
}

/* ---------- likes (stored locally, newest first) ---------- */
let likes = []; // loaded from the library file (see loadLibrary)
const isLiked = (t) => !!t && likes.some((l) => l.id === t.id);

function updateLikeButton() {
  const on = isLiked(current);
  likeBtn.classList.toggle("on", on);
  likeBtn.setAttribute("aria-pressed", String(on));
  likeBtn.title = on ? "Remove from liked tracks" : "Add to liked tracks";
}

function renderLikes() {
  // Home: the 12 newest as cards
  likedWrap.hidden = !likes.length;
  likedGrid.replaceChildren(...likes.slice(0, 12).map((t, i) => card(t, likes, i)));
  $("liked-all").hidden = likes.length <= 12;
  // Liked tracks page: everything as rows
  likedList.replaceChildren(...likes.map((t, i) => row(t, likes, i, false)));
  likedStatus.textContent = likes.length
    ? ""
    : "Nothing liked yet. Press the heart in the player to save a track.";
  updateHomeEmpty();
  updateLikeButton();
  markActive();
}

function toggleLikeFor(t) {
  likes = isLiked(t) ? likes.filter((l) => l.id !== t.id) : [slim(t), ...likes];
  saveLibrary();
  renderLikes();
}
likeBtn.addEventListener("click", () => current && toggleLikeFor(current));

/* ---------- playlists (stored locally) ---------- */
let playlists = []; // loaded from the library file (see loadLibrary)
let openPl = null; // id of the playlist page that is open
const savePlaylists = () => saveLibrary();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const plCount = (pl) => `${pl.tracks.length} ${pl.tracks.length === 1 ? "track" : "tracks"}`;
const plArt = (pl) => pl.cover || pl.tracks.find((t) => t.artwork)?.artwork || null;

function createPlaylist(name) {
  const pl = { id: uid(), name, tracks: [] };
  playlists.unshift(pl);
  savePlaylists();
  renderPlaylists();
  return pl;
}
function addToPlaylist(pl, t) {
  if (pl.tracks.some((s) => s.id === t.id)) return toast(`Already in ${pl.name}`);
  pl.tracks.push(slim(t));
  savePlaylists();
  renderPlaylists();
  toast(`Added to ${pl.name}`);
}
function removeFromPlaylist(plId, t) {
  const pl = playlists.find((p) => p.id === plId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter((s) => s.id !== t.id);
  savePlaylists();
  renderPlaylists();
}

function plCard(pl) {
  const c = make("div", "card");
  c.dataset.pl = pl.id;
  const img = make("img", "cover");
  img.alt = "";
  img.loading = "lazy";
  const a = plArt(pl);
  if (a) img.src = a;
  c.append(img, make("div", "title", pl.name), make("div", "artist", plCount(pl)));
  c.addEventListener("click", () => openPlaylist(pl.id));
  return c;
}
function plRow(pl) {
  const li = make("li", "track");
  li.dataset.pl = pl.id;
  const img = make("img", "art");
  img.alt = "";
  img.loading = "lazy";
  const a = plArt(pl);
  if (a) img.src = a;
  const info = make("div", "info");
  info.append(make("div", "title", pl.name), make("div", "artist", plCount(pl)));
  li.append(img, info);
  li.addEventListener("click", () => openPlaylist(pl.id));
  return li;
}

function renderPlaylists() {
  plWrap.hidden = !playlists.length;
  plGrid.replaceChildren(...playlists.slice(0, 12).map(plCard));
  plAll.replaceChildren(...playlists.map(plRow));
  plEmpty.textContent = playlists.length
    ? ""
    : "No playlists yet. Create one, then add tracks from the \u22EF menu or by right-clicking a track.";
  renderPlaylistDetail();
  updateHomeEmpty();
}

function renderPlaylistDetail() {
  if (openPl == null) return;
  const pl = playlists.find((p) => p.id === openPl);
  if (!pl) {
    openPl = null;
    return;
  }
  $("pl-name").textContent = pl.name;
  $("pl-meta").textContent = plCount(pl);
  plList.replaceChildren(...pl.tracks.map((t, i) => row(t, pl.tracks, i, false, pl.id)));
  plStatus.textContent = pl.tracks.length
    ? ""
    : "This playlist is empty. Add tracks from the \u22EF menu or by right-clicking a track.";
  $("pl-play").disabled = !pl.tracks.length;
  const art = plArt(pl);
  const img = $("pl-cover");
  if (art) img.src = art;
  else img.removeAttribute("src");
  $("pl-cover-btn").classList.toggle("empty", !art);
  $("pl-cover-hint").textContent = pl.cover ? "Change cover" : "Add cover";
  $("pl-cover-clear").hidden = !pl.cover;
  markActive();
}

function openPlaylist(id) {
  openPl = id;
  resetDeleteBtn();
  renderPlaylistDetail();
  showView("playlist");
  const sc = document.querySelector("#view-playlist .scroller");
  if (sc) sc.scrollTop = 0;
}

$("pl-new").addEventListener("click", () =>
  askName("New playlist", "Create", "", (name) => createPlaylist(name))
);
$("pl-back").addEventListener("click", () => showView("playlists"));
$("pl-play").addEventListener("click", () => {
  const pl = playlists.find((p) => p.id === openPl);
  if (pl && pl.tracks.length) playFrom(pl.tracks, 0);
});
$("pl-rename").addEventListener("click", () => {
  const pl = playlists.find((p) => p.id === openPl);
  if (!pl) return;
  askName("Rename playlist", "Save", pl.name, (name) => {
    pl.name = name;
    savePlaylists();
    renderPlaylists();
  });
});

// custom cover: centre-crop to a square, shrink, keep as a small JPEG data URL
function fileToCover(file, size = 480) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const out = Math.min(size, side);
      const c = document.createElement("canvas");
      c.width = c.height = out;
      c.getContext("2d").drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, out, out
      );
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not an image"));
    };
    img.src = url;
  });
}
$("pl-cover-btn").addEventListener("click", () => $("cover-file").click());
$("cover-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  const pl = playlists.find((p) => p.id === openPl);
  if (!file || !pl) return;
  try {
    pl.cover = await fileToCover(file);
  } catch {
    return toast("Couldn't read that image");
  }
  savePlaylists();
  renderPlaylists();
});
$("pl-cover-clear").addEventListener("click", () => {
  const pl = playlists.find((p) => p.id === openPl);
  if (!pl) return;
  delete pl.cover;
  savePlaylists();
  renderPlaylists();
});

// delete asks for a second click so it can't happen by accident
let delTimer;
function resetDeleteBtn() {
  clearTimeout(delTimer);
  const b = $("pl-delete");
  b.dataset.armed = "0";
  b.textContent = "Delete";
}
$("pl-delete").addEventListener("click", () => {
  const b = $("pl-delete");
  if (b.dataset.armed !== "1") {
    b.dataset.armed = "1";
    b.textContent = "Click again to delete";
    delTimer = setTimeout(resetDeleteBtn, 3000);
    return;
  }
  resetDeleteBtn();
  playlists = playlists.filter((p) => p.id !== openPl);
  openPl = null;
  savePlaylists();
  renderPlaylists();
  showView("playlists");
  toast("Playlist deleted");
});

/* ---------- library file: likes, playlists and covers ---------- */
let libraryChecked = false; // have we tried to load the file yet?
let libraryReady = false; // loaded OK, so it is safe to write
let saving = false;
let dirty = false;

const snapshot = () => ({ app: "aquatica", version: 1, likes, playlists });

// Saves are serialized and always write the newest state, so two quick changes can't land out of order.
function saveLibrary() {
  if (!libraryReady) return;
  dirty = true;
  if (!saving) flushLibrary();
}
async function flushLibrary() {
  saving = true;
  while (dirty) {
    dirty = false;
    try {
      await invoke("library_save", { data: JSON.stringify(snapshot()) });
    } catch (err) {
      toast(`Couldn't save your library: ${err}`);
    }
  }
  saving = false;
}

// Anything that comes from a file is checked before it touches the app.
function cleanTrack(t) {
  if (!t || typeof t !== "object") return null;
  const id = Number(t.id);
  if (!Number.isFinite(id) || typeof t.title !== "string") return null;
  return {
    id,
    title: t.title,
    artist: typeof t.artist === "string" ? t.artist : "",
    artwork: typeof t.artwork === "string" && t.artwork.startsWith("https://") ? t.artwork : null,
    duration: Number.isFinite(t.duration) ? t.duration : null,
  };
}
const cleanTracks = (list) =>
  (Array.isArray(list) ? list : []).map(cleanTrack).filter(Boolean).slice(0, 5000);

function cleanPlaylist(p) {
  if (!p || typeof p !== "object") return null;
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : "Untitled";
  const out = { id: typeof p.id === "string" && p.id ? p.id : uid(), name, tracks: cleanTracks(p.tracks) };
  if (typeof p.cover === "string" && p.cover.startsWith("data:image/") && p.cover.length < 3000000) {
    out.cover = p.cover;
  }
  return out;
}
const cleanPlaylists = (list) => (Array.isArray(list) ? list : []).map(cleanPlaylist).filter(Boolean);

async function loadLibrary() {
  try {
    let res;
    try {
      res = await invoke("library_load");
    } catch (err) {
      // can't read the file: leave saving switched off so nothing gets overwritten
      toast(`Couldn't open your library file: ${err}`);
      return;
    }
    if (res.quarantined) toast(`Your library file was damaged. A copy was kept as ${res.quarantined}`);

    let data = null;
    if (res.text) {
      try {
        data = JSON.parse(res.text);
      } catch {}
    }
    if (data) {
      likes = cleanTracks(data.likes);
      playlists = cleanPlaylists(data.playlists);
      libraryReady = true;
      return;
    }

    // no file yet: bring over what the old localStorage version had, once
    libraryReady = true;
    const oldLikes = store.get("aq-likes", []);
    const oldPlaylists = store.get("aq-playlists", []);
    if (oldLikes.length || oldPlaylists.length) {
      likes = cleanTracks(oldLikes);
      playlists = cleanPlaylists(oldPlaylists);
      try {
        await invoke("library_save", { data: JSON.stringify(snapshot()) });
        try {
          localStorage.removeItem("aq-likes");
          localStorage.removeItem("aq-playlists");
        } catch {}
        toast("Moved your likes and playlists into a library file");
      } catch (err) {
        toast(`Couldn't create the library file: ${err}`);
      }
    }
  } finally {
    libraryChecked = true;
    renderLikes();
    renderPlaylists();
  }
}

/* export / import */
const readText = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });

async function exportData(stem, payload) {
  try {
    const path = await invoke("export_file", { name: stem, contents: JSON.stringify(payload, null, 2) });
    if (!path) return; // the save dialog was cancelled
    const parts = path.split(/[\\/]/);
    toast(`Saved ${parts.pop()} in ${parts.pop() || "your folder"}`);
  } catch (err) {
    toast(`Export failed: ${err}`);
  }
}
const today = () => new Date().toISOString().slice(0, 10);

// Import only adds things. Same playlist id = fill in what's missing; new id = new playlist.
function mergeLibrary(data) {
  const r = { likes: 0, playlists: 0, tracks: 0 };
  const known = new Set(likes.map((l) => l.id));
  for (const t of cleanTracks(data.likes)) {
    if (known.has(t.id)) continue;
    likes.push(t);
    known.add(t.id);
    r.likes++;
  }
  for (const p of cleanPlaylists(data.playlists)) {
    const mine = playlists.find((x) => x.id === p.id);
    if (!mine) {
      playlists.push(p);
      r.playlists++;
      r.tracks += p.tracks.length;
      continue;
    }
    const ids = new Set(mine.tracks.map((t) => t.id));
    for (const t of p.tracks) {
      if (ids.has(t.id)) continue;
      mine.tracks.push(t);
      ids.add(t.id);
      r.tracks++;
    }
    if (!mine.cover && p.cover) mine.cover = p.cover;
  }
  return r;
}

$("lib-export").addEventListener("click", () =>
  exportData(`aquatica-library-${today()}`, { ...snapshot(), kind: "library" })
);
$("pl-export").addEventListener("click", () => {
  const pl = playlists.find((p) => p.id === openPl);
  if (!pl) return;
  exportData(`aquatica-playlist-${pl.name}`, { app: "aquatica", version: 1, kind: "playlist", likes: [], playlists: [pl] });
});
$("lib-import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await readText(file));
  } catch {
    return toast("That file isn't valid JSON");
  }
  if (!data || data.app !== "aquatica") return toast("That doesn't look like an Aquatica export");
  const r = mergeLibrary(data);
  if (!r.likes && !r.playlists && !r.tracks) return toast("Nothing new in that file");
  saveLibrary();
  renderLikes();
  renderPlaylists();
  const bits = [];
  if (r.likes) bits.push(`${r.likes} liked`);
  if (r.playlists) bits.push(`${r.playlists} ${r.playlists === 1 ? "playlist" : "playlists"}`);
  if (r.tracks) bits.push(`${r.tracks} playlist ${r.tracks === 1 ? "track" : "tracks"}`);
  toast(`Imported ${bits.join(", ")}`);
});
invoke("library_path")
  .then((p) => ($("lib-path").textContent = p))
  .catch(() => {});

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
let preloadedId = null; // id of the track we asked the backend to buffer
let preloadTimer;

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
  updateLikeButton();
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
    if (index + 1 >= queue.length) schedulePreload(); // the next track is a suggestion
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
  preloadedId = null;
  clearTimeout(preloadTimer);
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
      // came from recent / liked / a playlist: fetch fresh stream info first
      t = await invoke("get_track", { id: t.id });
      if (my !== gen) return;
      queue[i] = t;
      current = t;
    }
    pushRecent(t);
    await invoke("play", { id: t.id, streamApi: t.streamApi, auth: t.auth });
    if (my === gen) {
      loadRelated(t);
      schedulePreload();
    }
  } catch (err) {
    if (my === gen) {
      setPlaying(false);
      toast(String(err));
    }
  } finally {
    if (my === gen) loading = false;
  }
}

// What nextTrack() would play: the next queue entry, or the first suggestion at the end.
function peekNext() {
  if (index + 1 < queue.length) return { list: queue, i: index + 1 };
  if (related.length) return { list: related, i: 0 };
  return null;
}

// Two seconds after a track starts, buffer the next one in a second paused mpv.
function schedulePreload() {
  clearTimeout(preloadTimer);
  const my = gen;
  preloadTimer = setTimeout(() => preloadNext(my), 2000);
}

async function preloadNext(my) {
  if (my !== gen) return;
  const p = peekNext();
  if (!p) return;
  let t = p.list[p.i];
  if (!t || preloadedId === t.id) return;
  preloadedId = t.id;
  try {
    if (!t.streamApi) {
      // slim track (playlist / liked): fetch stream info now, and keep it so playAt can skip this step
      t = await invoke("get_track", { id: t.id });
      if (my !== gen) return;
      p.list[p.i] = t;
    }
    await invoke("preload", { id: t.id, streamApi: t.streamApi, auth: t.auth });
  } catch {
    preloadedId = null; // optional: playback still works without it
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
  if (e.key === "Escape") {
    if (!nameModal.hidden) closeName();
    else closeMenu();
    return;
  }
  // typing in the search box or the name dialog must not trigger shortcuts
  if (!nameModal.hidden || !menuEl.hidden) return;
  const a = document.activeElement;
  const typing = a instanceof HTMLInputElement && a.type === "text";
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
  statusEl.textContent = results.children.length ? "" : "Searching\u2026";
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
applyZoom(false);
renderRecents();
showView("home");
loadLibrary(); // fills in likes + playlists, then renders them
