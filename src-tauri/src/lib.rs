use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

const SOCK: &str = "/tmp/aquatica-mpv.sock";
const API: &str = "https://api-v2.soundcloud.com";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// remembers which charts request form last worked
static CHART_VARIANT: AtomicUsize = AtomicUsize::new(0);

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

struct Player(Mutex<Option<Child>>);

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

// Home page charts. kind: "trending" or "top"; genre: e.g. "all-music".
// SoundCloud's charts endpoint is picky and has changed over time, so we try
// three request forms and remember whichever one worked last.
#[tauri::command]
async fn charts(kind: String, genre: String, sc: State<'_, Sc>) -> Result<Vec<Track>, String> {
    let genre_id = format!("soundcloud:genres:{genre}");
    let url = format!("{API}/charts");
    let start = CHART_VARIANT.load(Ordering::Relaxed);
    let mut last_err = String::from("no response");

    for n in 0..3usize {
        let variant = (start + n) % 3;
        let mut params: Vec<(&str, &str)> = vec![
            ("kind", kind.as_str()),
            ("genre", genre_id.as_str()),
            ("limit", "24"),
        ];
        match variant {
            1 => params.push(("high_tier_only", "false")),
            2 => {
                params.push(("high_tier_only", "false"));
                params.push(("region", "soundcloud:regions:US"));
            }
            _ => {}
        }
        match sc.get_json(&url, &params).await {
            Ok(v) => {
                let tracks: Vec<Track> = v["collection"]
                    .as_array()
                    .map(|items| items.iter().filter_map(|i| parse_track(&i["track"])).collect())
                    .unwrap_or_default();
                CHART_VARIANT.store(variant, Ordering::Relaxed);
                return Ok(tracks);
            }
            Err(e) => last_err = e,
        }
    }
    Err(format!("{last_err} (charts: {kind} / {genre})"))
}

// Fresh stream info for a track we only know the id of (recently played)
#[tauri::command]
async fn get_track(id: u64, sc: State<'_, Sc>) -> Result<Track, String> {
    let v = sc.get_json(&format!("{API}/tracks/{id}"), &[]).await?;
    parse_track(&v).ok_or_else(|| "that track can't be played".to_string())
}

// ---------- playback (mpv) ----------
#[tauri::command]
async fn play(
    stream_api: String,
    auth: String,
    sc: State<'_, Sc>,
    player: State<'_, Player>,
) -> Result<(), String> {
    let v = sc
        .get_json(&stream_api, &[("track_authorization", auth.as_str())])
        .await?;
    let url = v["url"].as_str().ok_or("no stream url returned")?.to_string();

    let mut guard = player.0.lock().unwrap();
    if let Some(mut old) = guard.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let _ = std::fs::remove_file(SOCK);

    let child = Command::new("mpv")
        .args([
            "--no-video",
            "--force-window=no",
            "--really-quiet",
            "--ytdl=no",
            "--audio-display=no",
            &format!("--input-ipc-server={}", SOCK),
            &url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("couldn't start mpv: {e}"))?;

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn toggle_pause() -> Result<(), String> {
    let mut s = UnixStream::connect(SOCK).map_err(|e| e.to_string())?;
    s.write_all(b"{\"command\":[\"cycle\",\"pause\"]}\n")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop(player: State<Player>) {
    if let Some(mut c) = player.0.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn mpv_send(cmd: &str) -> Result<(), String> {
    let mut s = UnixStream::connect(SOCK).map_err(|e| e.to_string())?;
    s.write_all(format!("{cmd}\n").as_bytes())
        .map_err(|e| e.to_string())
}

// Ask mpv for several properties at once. None = mpv isn't running.
fn mpv_get(props: &[&str]) -> Option<Vec<Value>> {
    let mut stream = UnixStream::connect(SOCK).ok()?;
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
}

impl PlayerState {
    fn idle() -> Self {
        PlayerState { running: false, position: 0.0, duration: 0.0, paused: false }
    }
}

#[tauri::command]
async fn player_state() -> PlayerState {
    tauri::async_runtime::spawn_blocking(|| {
        match mpv_get(&["time-pos", "duration", "pause"]) {
            Some(v) => PlayerState {
                running: true,
                position: v[0].as_f64().unwrap_or(0.0),
                duration: v[1].as_f64().unwrap_or(0.0),
                paused: v[2].as_bool().unwrap_or(false),
            },
            None => PlayerState::idle(),
        }
    })
    .await
    .unwrap_or_else(|_| PlayerState::idle())
}

#[tauri::command]
fn seek(seconds: f64) -> Result<(), String> {
    mpv_send(&format!(
        "{{\"command\":[\"seek\",{},\"absolute\"]}}",
        seconds.max(0.0)
    ))
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

// ---------- app ----------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Player(Mutex::new(None)))
        .manage(Sc::new())
        .on_window_event(|window, event| {
            // stop mpv when the window goes away
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut c) = window.state::<Player>().0.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        })
        .setup(|app| {
            // fetch the client id in the background so the first request is fast
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let sc = handle.state::<Sc>();
                let _ = sc.client_id(false).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search, related, charts, get_track, play, toggle_pause, stop,
            player_state, seek, start_drag, win_minimize, win_toggle_max, win_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aquatica");
}
