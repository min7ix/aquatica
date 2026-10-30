use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

// two mpv sockets: one for the track that is playing, one for the preloaded next track
const SOCKS: [&str; 2] = ["/tmp/aquatica-mpv-0.sock", "/tmp/aquatica-mpv-1.sock"];
const API: &str = "https://api-v2.soundcloud.com";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    id: u64,
    title: String,
    artist: String,
    duration: Option<f64>,
    artwork: Option<String>,
    stream_api: String,
    auth: String,
}

// A running mpv process. `slot` picks its socket, `track` is the SoundCloud track id.
struct Slot {
    child: Child,
    slot: usize,
    track: i64, // SoundCloud id, or a negative id for your own files
}

// `active` is playing. `next` is already loaded and buffering, paused, ready to take over.
#[derive(Default)]
struct PlayerInner {
    active: Option<Slot>,
    next: Option<Slot>,
}

struct Player(Mutex<PlayerInner>);

fn kill_slot(s: Option<Slot>) {
    if let Some(mut s) = s {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

fn active_info(player: &Player) -> Option<(&'static str, i64)> {
    player.0.lock().unwrap().active.as_ref().map(|s| (SOCKS[s.slot], s.track))
}

fn active_sock(player: &Player) -> Option<&'static str> {
    player.0.lock().unwrap().active.as_ref().map(|s| SOCKS[s.slot])
}

// ---------- SoundCloud web API ----------
// The "client id" is a public key the website itself uses; we read it from
// the site once and reuse it.
struct Sc {
    http: reqwest::Client,
    client_id: Mutex<Option<String>>,
}

impl Sc {
    fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(UA)
            .build()
            .expect("http client");
        Sc { http, client_id: Mutex::new(None) }
    }

    async fn client_id(&self, refresh: bool) -> Result<String, String> {
        if !refresh {
            let cached = self.client_id.lock().unwrap().clone();
            if let Some(id) = cached {
                return Ok(id);
            }
        }
        let id = self.scrape_client_id().await?;
        *self.client_id.lock().unwrap() = Some(id.clone());
        Ok(id)
    }

    async fn scrape_client_id(&self) -> Result<String, String> {
        let html = self
            .http
            .get("https://soundcloud.com")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;

        let script_re =
            Regex::new(r#"src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)""#).unwrap();
        let id_re = Regex::new(r#"client_id\s*:\s*"([0-9a-zA-Z]{32})""#).unwrap();

        let scripts: Vec<String> = script_re
            .captures_iter(&html)
            .map(|c| c[1].to_string())
            .collect();

        for url in scripts.iter().rev() {
            let js = match self.http.get(url).send().await {
                Ok(r) => match r.text().await {
                    Ok(t) => t,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            if let Some(c) = id_re.captures(&js) {
                return Ok(c[1].to_string());
            }
        }
        Err("couldn't find a SoundCloud client id".into())
    }

    async fn get_json(&self, url: &str, params: &[(&str, &str)]) -> Result<Value, String> {
        for attempt in 0..2 {
            let cid = self.client_id(attempt == 1).await?;
            let resp = self
                .http
                .get(url)
                .query(params)
                .query(&[("client_id", cid.as_str())])
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            // client id expired: refresh it and try once more
            if (status.as_u16() == 401 || status.as_u16() == 403) && attempt == 0 {
                continue;
            }
            if !status.is_success() {
                return Err(format!("SoundCloud returned {status}"));
            }
            return resp.json::<Value>().await.map_err(|e| e.to_string());
        }
        Err("request failed".into())
    }
}

// Prefer a plain mp3 stream, fall back to HLS. Skip 30-second previews.
fn pick_stream(media: &Value) -> Option<String> {
    let list = media["transcodings"].as_array()?;
    let mut hls = None;
    for t in list {
        if t["snipped"].as_bool().unwrap_or(false) {
            continue;
        }
        let url = match t["url"].as_str() {
            Some(u) => u,
            None => continue,
        };
        match t["format"]["protocol"].as_str() {
            Some("progressive") => return Some(url.to_string()),
            Some("hls") if hls.is_none() => hls = Some(url.to_string()),
            _ => {}
        }
    }
    hls
}

fn parse_track(t: &Value) -> Option<Track> {
    Some(Track {
        id: t["id"].as_u64()?,
        title: t["title"].as_str()?.to_string(),
        artist: t["user"]["username"].as_str().unwrap_or("Unknown").to_string(),
        duration: t["duration"].as_f64().map(|ms| ms / 1000.0),
        artwork: t["artwork_url"]
            .as_str()
            .or_else(|| t["user"]["avatar_url"].as_str())
            .map(|u| u.replace("-large", "-t300x300")),
        stream_api: pick_stream(&t["media"])?,
        auth: t["track_authorization"].as_str()?.to_string(),
    })
}

fn parse_tracks(list: &Value) -> Vec<Track> {
    list.as_array()
        .map(|items| items.iter().filter_map(parse_track).collect())
        .unwrap_or_default()
}

#[tauri::command]
async fn search(query: String, sc: State<'_, Sc>) -> Result<Vec<Track>, String> {
    let v = sc
        .get_json(
            &format!("{API}/search/tracks"),
            &[("q", query.as_str()), ("limit", "25")],
        )
        .await?;
    Ok(parse_tracks(&v["collection"]))
}

// "Suggested" tracks for the right column
#[tauri::command]
async fn related(id: u64, sc: State<'_, Sc>) -> Result<Vec<Track>, String> {
    let v = sc
        .get_json(&format!("{API}/tracks/{id}/related"), &[("limit", "8")])
        .await?;
    Ok(parse_tracks(&v["collection"]))
}

// Fresh stream info for a track we only know the id of (recently played, liked)
#[tauri::command]
async fn get_track(id: u64, sc: State<'_, Sc>) -> Result<Track, String> {
    let v = sc.get_json(&format!("{API}/tracks/{id}"), &[]).await?;
    parse_track(&v).ok_or_else(|| "that track can't be played".to_string())
}

// ---------- playback (mpv) ----------
async fn resolve(sc: &Sc, stream_api: &str, auth: &str) -> Result<String, String> {
    let v = sc
        .get_json(stream_api, &[("track_authorization", auth)])
        .await?;
    Ok(v["url"].as_str().ok_or("no stream url returned")?.to_string())
}

// Where is mpv? Apps started from Finder or a launcher don't get the shell PATH,
// so Homebrew's mpv is invisible to them unless we look in the usual places.
fn music_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = lib_dir(app)?.join("music");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Your files are stored under generated names like 1787123456789012.mp3. Refuse anything else,
// so a hand-edited library file can't point the player at arbitrary paths.
fn local_path(app: &tauri::AppHandle, file: &str) -> Result<PathBuf, String> {
    let ok = !file.is_empty()
        && file.len() < 64
        && file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
        && !file.contains("..");
    if !ok {
        return Err("bad file name".into());
    }
    let p = music_dir(app)?.join(file);
    if !p.is_file() {
        return Err("that file isn't in this library".into());
    }
    Ok(p)
}

async fn source_url(
    app: &tauri::AppHandle,
    sc: &Sc,
    stream_api: Option<String>,
    auth: Option<String>,
    file: Option<String>,
) -> Result<String, String> {
    if let Some(f) = file {
        return Ok(local_path(app, &f)?.to_string_lossy().to_string());
    }
    let api = stream_api.ok_or("no stream info for that track")?;
    resolve(sc, &api, &auth.unwrap_or_default()).await
}

fn mpv_path() -> PathBuf {
    // 1. shipped next to the app (a bundled copy wins)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for rel in ["mpv", "../Resources/mpv"] {
                let p = dir.join(rel);
                if p.is_file() {
                    return p;
                }
            }
        }
    }
    // 2. PATH
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join("mpv");
            if p.is_file() {
                return p;
            }
        }
    }
    // 3. the usual install spots
    for p in [
        "/opt/homebrew/bin/mpv",
        "/usr/local/bin/mpv",
        "/opt/local/bin/mpv",
        "/usr/bin/mpv",
        "/snap/bin/mpv",
        "/Applications/mpv.app/Contents/MacOS/mpv",
    ] {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from("mpv")
}

fn spawn_mpv(url: &str, sock: &str, paused: bool) -> Result<Child, String> {
    let _ = std::fs::remove_file(sock);
    let mut cmd = Command::new(mpv_path());
    cmd.args([
        "--no-video",
        "--force-window=no",
        "--really-quiet",
        "--ytdl=no",
        "--audio-display=no",
        "--cache=yes",
        "--demuxer-max-bytes=64MiB",
    ]);
    if paused {
        // start paused: mpv still opens the stream and keeps buffering
        cmd.arg("--pause");
    }
    cmd.arg(format!("--input-ipc-server={sock}"))
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                if cfg!(target_os = "macos") {
                    "mpv not found. Install it: brew install mpv".to_string()
                } else {
                    "mpv not found. Install it with your package manager".to_string()
                }
            } else {
                format!("couldn't start mpv: {e}")
            }
        })
}

#[tauri::command]
async fn play(
    app: tauri::AppHandle,
    id: i64,
    stream_api: Option<String>,
    auth: Option<String>,
    file: Option<String>,
    sc: State<'_, Sc>,
    player: State<'_, Player>,
) -> Result<(), String> {
    // Fast path: this track was preloaded, so just unpause it.
    {
        let mut g = player.0.lock().unwrap();
        let ready = matches!(&g.next, Some(n) if n.track == id);
        if ready {
            let mut n = g.next.take().unwrap();
            let alive = matches!(n.child.try_wait(), Ok(None));
            if alive {
                kill_slot(g.active.take());
                if mpv_send(SOCKS[n.slot], "{\"command\":[\"set_property\",\"pause\",false]}").is_ok() {
                    g.active = Some(n);
                    return Ok(());
                }
            }
            kill_slot(Some(n)); // preload died or isn't answering: fall through to a normal start
        }
    }

    // Normal path: look up the stream, start a fresh mpv.
    let url = source_url(&app, &sc, stream_api, auth, file).await?;
    let mut g = player.0.lock().unwrap();
    kill_slot(g.active.take());
    kill_slot(g.next.take());
    let child = spawn_mpv(&url, SOCKS[0], false)?;
    g.active = Some(Slot { child, slot: 0, track: id });
    Ok(())
}

// Load the upcoming track into a second, paused mpv so it can start instantly later.
#[tauri::command]
async fn preload(
    app: tauri::AppHandle,
    id: i64,
    stream_api: Option<String>,
    auth: Option<String>,
    file: Option<String>,
    sc: State<'_, Sc>,
    player: State<'_, Player>,
) -> Result<(), String> {
    let known = |g: &PlayerInner| {
        g.active.as_ref().map_or(false, |a| a.track == id)
            || g.next.as_ref().map_or(false, |n| n.track == id)
    };
    if known(&*player.0.lock().unwrap()) {
        return Ok(());
    }
    let url = source_url(&app, &sc, stream_api, auth, file).await?;
    let mut g = player.0.lock().unwrap();
    if known(&*g) {
        return Ok(()); // things moved on while we were looking it up
    }
    kill_slot(g.next.take());
    let slot = match &g.active {
        Some(a) => 1 - a.slot,
        None => 0,
    };
    let child = spawn_mpv(&url, SOCKS[slot], true)?;
    g.next = Some(Slot { child, slot, track: id });
    Ok(())
}

#[tauri::command]
fn toggle_pause(player: State<Player>) -> Result<(), String> {
    let sock = active_sock(&player).ok_or("nothing is playing")?;
    mpv_send(sock, "{\"command\":[\"cycle\",\"pause\"]}")
}

#[tauri::command]
fn stop(player: State<Player>) {
    let mut g = player.0.lock().unwrap();
    kill_slot(g.active.take());
    kill_slot(g.next.take());
}

fn mpv_send(sock: &str, cmd: &str) -> Result<(), String> {
    let mut s = UnixStream::connect(sock).map_err(|e| e.to_string())?;
    s.write_all(format!("{cmd}\n").as_bytes())
        .map_err(|e| e.to_string())
}

// Ask mpv for several properties at once. None = mpv isn't running.
fn mpv_get(sock: &str, props: &[&str]) -> Option<Vec<Value>> {
    let mut stream = UnixStream::connect(sock).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(400))).ok()?;
    for (i, p) in props.iter().enumerate() {
        let req = format!(
            "{{\"command\":[\"get_property\",\"{}\"],\"request_id\":{}}}\n",
            p,
            i + 1
        );
        stream.write_all(req.as_bytes()).ok()?;
    }
    let mut out = vec![Value::Null; props.len()];
    let mut got = 0;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    while got < props.len() {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let Some(id) = v["request_id"].as_u64() {
                let idx = (id as usize).wrapping_sub(1);
                if idx < out.len() {
                    out[idx] = v["data"].clone();
                    got += 1;
                }
            }
        }
    }
    Some(out)
}

#[derive(Serialize)]
struct PlayerState {
    running: bool,
    position: f64,
    duration: f64,
    paused: bool,
    track: Option<i64>, // which track the playing mpv belongs to
}

impl PlayerState {
    fn idle() -> Self {
        PlayerState { running: false, position: 0.0, duration: 0.0, paused: false, track: None }
    }
}

#[tauri::command]
async fn player_state(player: State<'_, Player>) -> Result<PlayerState, String> {
    let (sock, track) = match active_info(&player) {
        Some(x) => x,
        None => return Ok(PlayerState::idle()),
    };
    let state = tauri::async_runtime::spawn_blocking(move || {
        match mpv_get(sock, &["time-pos", "duration", "pause"]) {
            Some(v) => PlayerState {
                running: true,
                position: v[0].as_f64().unwrap_or(0.0),
                duration: v[1].as_f64().unwrap_or(0.0),
                paused: v[2].as_bool().unwrap_or(false),
                track: Some(track),
            },
            None => PlayerState::idle(),
        }
    })
    .await
    .unwrap_or_else(|_| PlayerState::idle());
    Ok(state)
}

#[tauri::command]
fn seek(seconds: f64, player: State<Player>) -> Result<(), String> {
    let sock = active_sock(&player).ok_or("nothing is playing")?;
    mpv_send(
        sock,
        &format!("{{\"command\":[\"seek\",{},\"absolute\"]}}", seconds.max(0.0)),
    )
}

// ---------- library (likes, playlists and covers live in one JSON file) ----------
fn lib_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
struct LibraryLoad {
    text: Option<String>,        // the file's contents, if there is one
    quarantined: Option<String>, // name of a damaged file we moved aside
}

#[tauri::command]
async fn library_load(app: tauri::AppHandle) -> Result<LibraryLoad, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<LibraryLoad, String> {
        let dir = lib_dir(&app)?;
        let path = dir.join("library.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LibraryLoad { text: None, quarantined: None });
            }
            Err(e) => return Err(e.to_string()),
        };
        if serde_json::from_str::<Value>(&text).is_ok() {
            return Ok(LibraryLoad { text: Some(text), quarantined: None });
        }
        // damaged file: keep a copy next to it and start clean instead of overwriting it
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let name = format!("library.corrupt-{ts}.json");
        std::fs::rename(&path, dir.join(&name)).map_err(|e| e.to_string())?;
        Ok(LibraryLoad { text: None, quarantined: Some(name) })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Write to a temp file first, keep the previous version as library.bak.json, then swap.
#[tauri::command]
async fn library_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        serde_json::from_str::<Value>(&data).map_err(|e| format!("not valid JSON: {e}"))?;
        let dir = lib_dir(&app)?;
        let path = dir.join("library.json");
        let tmp = dir.join("library.json.tmp");
        std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
        if path.exists() {
            let _ = std::fs::copy(&path, dir.join("library.bak.json"));
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn library_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(lib_dir(&app)?.join("library.json").to_string_lossy().to_string())
}

// Export: ask where to save with the native "Save as" dialog (starts in Downloads).
// Returns None if the dialog was cancelled.
#[tauri::command]
async fn export_file(
    app: tauri::AppHandle,
    name: String,
    contents: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let cleaned: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        let cleaned = cleaned.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
        let stem: String = if cleaned.is_empty() {
            "aquatica-export".to_string()
        } else {
            cleaned.chars().take(80).collect()
        };

        let mut dialog = app
            .dialog()
            .file()
            .set_title("Export")
            .set_file_name(format!("{stem}.json"))
            .add_filter("JSON", &["json"]);
        if let Ok(dir) = app.path().download_dir().or_else(|_| app.path().home_dir()) {
            dialog = dialog.set_directory(dir);
        }
        let picked = match dialog.blocking_save_file() {
            Some(p) => p,
            None => return Ok(None),
        };
        let mut path = picked.into_path().map_err(|e| e.to_string())?;
        if path.extension().is_none() {
            path.set_extension("json");
        }
        std::fs::write(&path, contents).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- your own music ----------
const AUDIO_EXTS: [&str; 10] = ["mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "wma", "aiff", "aif"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTrack {
    id: i64,
    title: String,
    artist: String,
    duration: Option<f64>,
    file: String,
    local: bool,
}

// Title / artist / length from the file's tags. Falls back to the file name ("Artist - Title" works too).
fn read_tags(copied: &Path, original: &Path) -> (String, String, Option<f64>) {
    use lofty::prelude::*;
    let stem = original
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();
    let mut title = stem.clone();
    let mut artist = String::new();
    let mut duration = None;
    if let Some((a, t)) = stem.split_once(" - ") {
        artist = a.trim().to_string();
        title = t.trim().to_string();
    }
    if let Ok(tagged) = lofty::read_from_path(copied) {
        let secs = tagged.properties().duration().as_secs_f64();
        if secs > 0.0 {
            duration = Some(secs);
        }
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = tag.title() {
                let t = t.trim();
                if !t.is_empty() {
                    title = t.to_string();
                }
            }
            if let Some(a) = tag.artist() {
                let a = a.trim();
                if !a.is_empty() {
                    artist = a.to_string();
                }
            }
        }
    }
    if artist.is_empty() {
        artist = "Unknown artist".to_string();
    }
    (title, artist, duration)
}

// Pick audio files, copy them into the app's music folder, read their tags.
#[tauri::command]
async fn local_import(app: tauri::AppHandle) -> Result<Vec<LocalTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<LocalTrack>, String> {
        let picked = match app
            .dialog()
            .file()
            .set_title("Add music")
            .add_filter("Audio", &AUDIO_EXTS)
            .blocking_pick_files()
        {
            Some(p) => p,
            None => return Ok(vec![]),
        };
        let dir = music_dir(&app)?;
        let base = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut out = Vec::new();
        for (n, fp) in picked.into_iter().enumerate() {
            let src = match fp.into_path() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !AUDIO_EXTS.contains(&ext.as_str()) {
                continue;
            }
            // negative ids can never clash with SoundCloud track ids
            let id = -(base * 1000 + n as i64);
            let file = format!("{}.{}", id.unsigned_abs(), ext);
            let dest = dir.join(&file);
            if std::fs::copy(&src, &dest).is_err() {
                continue;
            }
            let (title, artist, duration) = read_tags(&dest, &src);
            out.push(LocalTrack { id, title, artist, duration, file, local: true });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn local_delete(app: tauri::AppHandle, file: String) -> Result<(), String> {
    let p = local_path(&app, &file)?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

// ---------- window (we draw our own frame) ----------
#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn win_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_max(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn win_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

// Interface zoom from the Settings page (1.0 = 100%)
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, factor: f64) {
    let _ = window.set_zoom(factor.clamp(0.5, 2.0));
}

// ---------- app ----------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Player(Mutex::new(PlayerInner::default())))
        .manage(Sc::new())
        .on_window_event(|window, event| {
            // stop mpv when the window goes away
            if let tauri::WindowEvent::Destroyed = event {
                let st = window.state::<Player>();
                let mut g = st.0.lock().unwrap();
                kill_slot(g.active.take());
                kill_slot(g.next.take());
            }
        })
        .setup(|app| {
            // fetch the client id in the background so the first request is fast
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let sc = handle.state::<Sc>();
                let _ = sc.client_id(false).await;
            });

            // When a track ends by itself and the next one is already buffered, start it right away
            // instead of waiting for the UI to notice. The UI follows via player_state.
            let watcher = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(40));
                let st = watcher.state::<Player>();
                let mut g = st.0.lock().unwrap();
                let ended = match g.active.as_mut() {
                    Some(a) => matches!(a.child.try_wait(), Ok(Some(_))),
                    None => false,
                };
                if !ended {
                    continue;
                }
                if let Some(mut n) = g.next.take() {
                    let alive = matches!(n.child.try_wait(), Ok(None));
                    if alive
                        && mpv_send(SOCKS[n.slot], "{\"command\":[\"set_property\",\"pause\",false]}").is_ok()
                    {
                        kill_slot(g.active.take());
                        g.active = Some(n);
                    } else {
                        kill_slot(Some(n));
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search, related, get_track, play, preload, toggle_pause, stop,
            player_state, seek, start_drag, win_minimize, win_toggle_max, win_close,
            set_zoom, library_load, library_save, library_path, export_file,
            local_import, local_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aquatica");
}
