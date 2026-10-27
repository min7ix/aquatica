const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const sheet = $("sheet");
const main = $("main");
const form = $("search-form");
const input = $("search-input");
const statusEl = $("status");
const resultsLabel = $("results-label");
const results = $("results");
const bg = $("bg");
const player = $("player");
const npTitle = $("np-title");
const npArtist = $("np-artist");
const npArt = $("np-art");
const bigArt = $("np-big");
const bigTitle = $("np-big-title");
const bigArtist = $("np-big-artist");
const seek = $("seek");
const tCur = $("t-cur");
const tDur = $("t-dur");

const HINT = "Search for tracks, artists and mixes";

let shown = []; // tracks listed in the search view
let rows = [];
let queue = []; // tracks the player is working through
let index = -1;
let playing = false;
let started = false; // have we seen mpv come up for this track?
let loading = false;
let waited = 0;
let gen = 0; // bumps on every new track so stale polls are ignored
let dragging = false; // dragging the seek bar
let duration = 0;
let searchSeq = 0;
let lastQuery = "";
let debounce = null;

function fmt(sec) {
  if (!sec || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
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

/* ---------- sidebar + views ---------- */
try {
  if (localStorage.getItem("aq-collapsed") === "1") sheet.dataset.collapsed = "true";
} catch {}

$("collapse").addEventListener("click", () => {
  const v = sheet.dataset.collapsed !== "true";
  sheet.dataset.collapsed = String(v);
  try { localStorage.setItem("aq-collapsed", v ? "1" : "0"); } catch {}
});

function showView(name) {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "search") input.focus();
}
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view))
);
$("login-btn").addEventListener("click", () => {
  $("login-note").textContent = "Login arrives in the next step.";
});

/* ---------- list ---------- */
function row(t, i) {
  const li = document.createElement("li");
  li.className = "track";

  const img = document.createElement("img");
  img.className = "art";
  img.alt = "";
  img.loading = "lazy";
  if (t.artwork) img.src = t.artwork;

  const info = document.createElement("div");
  info.className = "info";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title;
  const artist = document.createElement("div");
  artist.className = "artist";
  artist.textContent = t.artist;
  info.append(title, artist);

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = t.duration ? fmt(t.duration) : "";

  li.append(img, info, time);
  li.addEventListener("click", () => {
    queue = shown;
    playAt(i);
  });
  return li;
}

function markActive() {
  rows.forEach((li, i) => li.classList.toggle("active", queue === shown && i === index));
}

/* ---------- playback ---------- */
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
  npTitle.textContent = t.title;
  npArtist.textContent = t.artist;
  bigTitle.textContent = t.title;
  bigArtist.textContent = t.artist;

  if (t.artwork) {
    npArt.src = t.artwork;
    npArt.hidden = false;
    bg.style.backgroundImage = `url("${t.artwork}")`;
    bigArt.onerror = () => {
      bigArt.onerror = null;
      bigArt.src = t.artwork;
    };
    bigArt.src = t.artwork.replace("-t300x300", "-t500x500");
    bigArt.hidden = false;
  } else {
    npArt.hidden = true;
    bigArt.hidden = true;
    bg.style.backgroundImage = "none";
  }
  player.hidden = false;
  main.classList.add("has-player");
  sheet.classList.add("has-track");
}

async function playAt(i) {
  const t = queue[i];
  if (!t) return;
  index = i;
  const my = ++gen;
  loading = true;
  started = false;
  waited = 0;
  duration = t.duration || 0;
  showNowPlaying(t);
  updateSeek(0);
  markActive();
  setPlaying(true);
  statusEl.textContent = results.children.length ? "" : statusEl.textContent;
  try {
    await invoke("play", { streamApi: t.streamApi, auth: t.auth });
  } catch (err) {
    if (my === gen) {
      setPlaying(false);
      statusEl.textContent = String(err);
    }
  } finally {
    if (my === gen) loading = false;
  }
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
    if (index + 1 < queue.length) {
      playAt(index + 1);
    } else {
      setPlaying(false);
      updateSeek(0);
    }
  } else if (playing && ++waited > 16) {
    setPlaying(false);
    statusEl.textContent = "Couldn't play that track";
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

$("next").addEventListener("click", () => {
  if (index + 1 < queue.length) playAt(index + 1);
});

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
    $("toggle").click();
  } else if (e.key === "/" && !typing) {
    e.preventDefault();
    showView("search");
  }
});

/* ---------- search (live) ---------- */
function resetSearch() {
  searchSeq++;
  lastQuery = "";
  shown = [];
  rows = [];
  results.replaceChildren();
  resultsLabel.hidden = true;
  statusEl.textContent = HINT;
}

async function runSearch(q) {
  const my = ++searchSeq;
  lastQuery = q;
  // keep the old results on screen while the new ones load
  statusEl.textContent = rows.length ? "" : "Searching…";
  try {
    const tracks = await invoke("search", { query: q });
    if (my !== searchSeq) return; // a newer search took over
    shown = tracks;
    statusEl.textContent = tracks.length ? "" : "No results";
    resultsLabel.hidden = !tracks.length;
    rows = tracks.map(row);
    results.replaceChildren(...rows);
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

form.addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(debounce);
  const q = input.value.trim();
  if (q) runSearch(q);
});

input.focus();
