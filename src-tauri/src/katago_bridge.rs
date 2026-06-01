use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

const COLUMNS: &str = "ABCDEFGHJKLMNOPQRST";
const KATAGO_MODEL_URL: &str = "https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz";
const KATAGO_CONFIG_URL: &str =
    "https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/configs/gtp_example.cfg";

#[derive(Clone)]
struct BridgeConfig {
    port: u16,
    katago_bin: PathBuf,
    katago_model: Option<PathBuf>,
    katago_config: Option<PathBuf>,
    override_config: String,
    log_dir: PathBuf,
}

impl BridgeConfig {
    fn new() -> Self {
        let port = env::var("KATAGO_BRIDGE_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(3107);

        let installed_root = katago_install_root();
        let installed_bin = installed_root.join("bin/katago");
        let installed_model = installed_root.join("models/default.bin.gz");
        let installed_config = installed_root.join("configs/gtp_example.cfg");

        let katago_bin = env::var_os("KATAGO_BIN").map(PathBuf::from).unwrap_or_else(|| {
            if installed_bin.exists() {
                installed_bin
            } else {
                PathBuf::from("/opt/homebrew/bin/katago")
            }
        });
        let katago_share = env::var_os("KATAGO_SHARE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/homebrew/opt/katago/share/katago"));
        let log_dir = env::var_os("KATAGO_LOG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::temp_dir().join("go-game-katago-logs"));

        let model_candidates = [
            env::var_os("KATAGO_MODEL").map(PathBuf::from),
            Some(installed_model),
            Some(katago_share.join("kata1-b18c384nbt-s9996604416-d4316597426.bin.gz")),
            Some(katago_share.join("g170e-b20c256x2-s5303129600-d1228401921.bin.gz")),
            Some(katago_share.join("g170-b40c256x2-s5095420928-d1229425124.bin.gz")),
        ];
        let config_candidates = [
            env::var_os("KATAGO_CONFIG").map(PathBuf::from),
            Some(installed_config),
            Some(katago_share.join("configs/gtp_example.cfg")),
        ];

        let override_config = env::var("KATAGO_OVERRIDE_CONFIG").unwrap_or_else(|_| {
            format!(
                "maxVisits=96,numSearchThreads=4,ponderingEnabled=false,allowResignation=false,logDir={},logAllGTPCommunication=false,logSearchInfo=false,logToStderr=false",
                log_dir.display()
            )
        });

        Self {
            port,
            katago_bin,
            katago_model: first_existing(&model_candidates),
            katago_config: first_existing(&config_candidates),
            override_config,
            log_dir,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KataGoSetupStatus {
    ok: bool,
    running: bool,
    katago_bin: Option<String>,
    katago_model: Option<String>,
    katago_config: Option<String>,
    install_dir: String,
    message: String,
}

fn katago_install_root() -> PathBuf {
    env::var_os("GO_GAME_KATAGO_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join("Library/Application Support/go-game/katago"))
        })
        .unwrap_or_else(|| env::temp_dir().join("go-game/katago"))
}

fn setup_status(running: bool) -> KataGoSetupStatus {
    let config = BridgeConfig::new();
    let ok = config.katago_bin.exists()
        && config.katago_model.is_some()
        && config.katago_config.is_some();

    KataGoSetupStatus {
        ok,
        running,
        katago_bin: config
            .katago_bin
            .exists()
            .then(|| config.katago_bin.display().to_string()),
        katago_model: config
            .katago_model
            .as_ref()
            .map(|path| path.display().to_string()),
        katago_config: config
            .katago_config
            .as_ref()
            .map(|path| path.display().to_string()),
        install_dir: katago_install_root().display().to_string(),
        message: if ok {
            "KataGo is ready".to_string()
        } else {
            "KataGo runtime is not installed".to_string()
        },
    }
}

#[tauri::command]
pub fn katago_setup_status() -> KataGoSetupStatus {
    setup_status(false)
}

#[tauri::command]
pub fn install_katago_runtime(_app: AppHandle) -> Result<KataGoSetupStatus, String> {
    let root = katago_install_root();
    let bin_dir = root.join("bin");
    let model_dir = root.join("models");
    let config_dir = root.join("configs");
    let downloads_dir = root.join("downloads");

    fs::create_dir_all(&bin_dir).map_err(|error| format!("Failed to create bin dir: {error}"))?;
    fs::create_dir_all(&model_dir)
        .map_err(|error| format!("Failed to create model dir: {error}"))?;
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Failed to create config dir: {error}"))?;
    fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("Failed to create download dir: {error}"))?;

    match find_katago_release_asset_url(&downloads_dir)? {
        Some(release_asset_url) => {
            install_katago_from_release(&release_asset_url, &downloads_dir, &bin_dir)?;
        }
        None => {
            install_katago_with_homebrew()?;
        }
    }

    let model_path = model_dir.join("default.bin.gz");
    if !model_path.exists() {
        run_command(
            "curl",
            &[
                "-L",
                "--fail",
                "--show-error",
                "--output",
                path_str(&model_path)?,
                KATAGO_MODEL_URL,
            ],
        )?;
    }

    let config_path = config_dir.join("gtp_example.cfg");
    if !config_path.exists() {
        run_command(
            "curl",
            &[
                "-L",
                "--fail",
                "--show-error",
                "--output",
                path_str(&config_path)?,
                KATAGO_CONFIG_URL,
            ],
        )?;
    }

    let status = setup_status(false);
    if status.ok {
        Ok(status)
    } else {
        Err("KataGo files were downloaded, but setup validation did not pass".to_string())
    }
}

fn install_katago_from_release(
    release_asset_url: &str,
    downloads_dir: &Path,
    bin_dir: &Path,
) -> Result<(), String> {
    let archive_path = downloads_dir.join("katago.zip");
    run_command(
        "curl",
        &[
            "-L",
            "--fail",
            "--show-error",
            "--output",
            path_str(&archive_path)?,
            release_asset_url,
        ],
    )?;

    let extract_dir = downloads_dir.join("katago-release");
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir)
            .map_err(|error| format!("Failed to clear previous KataGo download: {error}"))?;
    }
    fs::create_dir_all(&extract_dir)
        .map_err(|error| format!("Failed to create extract dir: {error}"))?;
    run_command(
        "unzip",
        &[
            "-q",
            "-o",
            path_str(&archive_path)?,
            "-d",
            path_str(&extract_dir)?,
        ],
    )?;

    let extracted_bin = find_file_named(&extract_dir, "katago")
        .ok_or_else(|| "Downloaded KataGo archive did not contain a katago binary".to_string())?;
    let target_bin = bin_dir.join("katago");
    fs::copy(&extracted_bin, &target_bin)
        .map_err(|error| format!("Failed to install KataGo binary: {error}"))?;
    run_command("chmod", &["+x", path_str(&target_bin)?])
}

fn install_katago_with_homebrew() -> Result<(), String> {
    if Command::new("brew").arg("--version").output().is_err() {
        return Err(
            "KataGo does not publish macOS binaries in the latest release, and Homebrew is not installed".to_string(),
        );
    }

    run_command("brew", &["list", "katago"]).or_else(|_| run_command("brew", &["install", "katago"]))
}

fn find_katago_release_asset_url(downloads_dir: &Path) -> Result<Option<String>, String> {
    let metadata_path = downloads_dir.join("katago-release.json");
    run_command(
        "curl",
        &[
            "-L",
            "--fail",
            "--show-error",
            "--output",
            path_str(&metadata_path)?,
            "https://api.github.com/repos/lightvector/KataGo/releases/latest",
        ],
    )?;

    let metadata = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Failed to read KataGo release metadata: {error}"))?;
    let value: Value = serde_json::from_str(&metadata)
        .map_err(|error| format!("Failed to parse KataGo release metadata: {error}"))?;
    let arch = env::consts::ARCH;
    let wanted_arch = if arch == "aarch64" { "arm64" } else { "x64" };

    let release_asset_url = value
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets.iter().find_map(|asset| {
                let name = asset.get("name")?.as_str()?.to_ascii_lowercase();
                let url = asset.get("browser_download_url")?.as_str()?;
                let is_macos = name.contains("mac") || name.contains("osx");
                let is_archive = name.ends_with(".zip");
                let is_arch = name.contains(wanted_arch)
                    || (wanted_arch == "x64" && name.contains("x86_64"));
                (is_macos && is_archive && is_arch).then(|| url.to_string())
            })
        });

    Ok(release_asset_url)
}

fn find_file_named(root: &Path, file_name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.file_name().is_some_and(|name| name == file_name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, file_name) {
                return Some(found);
            }
        }
    }
    None
}

fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to run {program}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("{program} failed: {stderr}"))
    }
}

fn path_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("Path is not valid UTF-8: {}", path.display()))
}

fn first_existing(candidates: &[Option<PathBuf>]) -> Option<PathBuf> {
    candidates
        .iter()
        .filter_map(|candidate| candidate.as_ref())
        .find(|candidate| candidate.exists())
        .cloned()
}

pub fn start_bridge_server() {
    let config = BridgeConfig::new();
    let address = format!("127.0.0.1:{}", config.port);

    let listener = match TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("KataGo bridge did not start on {address}: {error}");
            return;
        }
    };

    thread::spawn(move || {
        eprintln!("KataGo bridge listening on http://{address}");
        let bridge = Arc::new(Mutex::new(KataGoBridge::new(config.clone())));

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let bridge = Arc::clone(&bridge);
                    let config = config.clone();
                    thread::spawn(move || handle_connection(stream, bridge, config));
                }
                Err(error) => eprintln!("KataGo bridge connection error: {error}"),
            }
        }
    });
}

struct HttpRequest {
    method: String,
    path: String,
    body: String,
}

fn handle_connection(
    mut stream: TcpStream,
    bridge: Arc<Mutex<KataGoBridge>>,
    config: BridgeConfig,
) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            send_json(&mut stream, 400, json!({ "error": error }));
            return;
        }
    };

    if request.method == "OPTIONS" {
        send_json(&mut stream, 204, json!({}));
        return;
    }

    let response: Result<Value, String> = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => {
            let running = bridge
                .lock()
                .map(|mut bridge| {
                    bridge.refresh_config();
                    bridge.is_running()
                })
                .unwrap_or(false);
            let current_config = BridgeConfig::new();
            Ok(json!({
                "ok": current_config.katago_bin.exists()
                    && current_config.katago_model.is_some()
                    && current_config.katago_config.is_some(),
                "running": running,
                "katagoBin": current_config.katago_bin,
                "katagoModel": current_config.katago_model,
                "katagoConfig": current_config.katago_config,
                "port": config.port,
            }))
        }
        ("POST", "/move") => match serde_json::from_str::<MovePayload>(&request.body) {
            Ok(payload) => bridge
                .lock()
                .map_err(|_| "KataGo bridge lock poisoned".to_string())
                .and_then(|mut bridge| {
                    bridge.get_move(
                        &payload.state,
                        payload.komi.unwrap_or(6.5),
                        payload.difficulty.as_deref().unwrap_or("normal"),
                    )
                })
                .map(|result| json!({ "engine": "katago", "result": result })),
            Err(error) => Err(format!("Invalid JSON: {error}")),
        },
        ("POST", "/analyze") => match serde_json::from_str::<AnalysisPayload>(&request.body) {
            Ok(payload) => {
                let duration_ms = payload.duration_ms.unwrap_or(800);
                bridge
                    .lock()
                    .map_err(|_| "KataGo bridge lock poisoned".to_string())
                    .and_then(|mut bridge| {
                        bridge.get_analysis(
                            &payload.state,
                            payload.komi.unwrap_or(6.5),
                            duration_ms,
                        )
                    })
                    .map(|analysis| json!({ "ok": true, "analysis": analysis }))
            }
            Err(error) => Err(format!("Invalid JSON: {error}")),
        },
        _ => Err("Not found".to_string()),
    };

    match response {
        Ok(payload) => send_json(&mut stream, 200, payload),
        Err(error) if error == "Not found" => {
            send_json(&mut stream, 404, json!({ "error": error }))
        }
        Err(error) => send_json(&mut stream, 500, json!({ "error": error })),
    }
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| format!("Failed to read request: {error}"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "Missing HTTP method".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "Missing HTTP path".to_string())?
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read headers: {error}"))?;
        if bytes == 0 {
            break;
        }

        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }

        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "Invalid Content-Length".to_string())?;
                if content_length > 2_000_000 {
                    return Err("Request body too large".to_string());
                }
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("Failed to read body: {error}"))?;
    }

    let body = String::from_utf8(body).map_err(|error| format!("Body is not UTF-8: {error}"))?;

    Ok(HttpRequest { method, path, body })
}

fn send_json(stream: &mut TcpStream, status_code: u16, payload: Value) {
    let reason = match status_code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = if status_code == 204 {
        String::new()
    } else {
        payload.to_string()
    };
    let response = format!(
        "HTTP/1.1 {status_code} {reason}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

struct KataGoBridge {
    config: BridgeConfig,
    process: Option<KataGoProcess>,
}

struct KataGoProcess {
    child: Child,
    stdout: BufReader<ChildStdout>,
}

impl KataGoBridge {
    fn new(config: BridgeConfig) -> Self {
        Self {
            config,
            process: None,
        }
    }

    fn is_running(&mut self) -> bool {
        if let Some(process) = self.process.as_mut() {
            match process.child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) | Err(_) => {
                    self.process = None;
                    false
                }
            }
        } else {
            false
        }
    }

    fn refresh_config(&mut self) {
        if !self.is_running() {
            self.config = BridgeConfig::new();
        }
    }

    fn ensure_started(&mut self) -> Result<(), String> {
        if let Some(process) = self.process.as_mut() {
            match process.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(status)) => {
                    eprintln!("KataGo exited ({status}); restarting on next request");
                    self.process = None;
                }
                Err(error) => return Err(format!("Failed to check KataGo process: {error}")),
            }
        }
        self.refresh_config();

        if !self.config.katago_bin.exists() {
            return Err(format!(
                "KataGo binary not found: {}",
                self.config.katago_bin.display()
            ));
        }
        let katago_model = self.config.katago_model.as_ref().ok_or_else(|| {
            "KataGo model not found. Set KATAGO_MODEL to a .bin.gz model path.".to_string()
        })?;
        let katago_config = self.config.katago_config.as_ref().ok_or_else(|| {
            "KataGo config not found. Set KATAGO_CONFIG to a gtp config path.".to_string()
        })?;

        fs::create_dir_all(&self.config.log_dir)
            .map_err(|error| format!("Failed to create KataGo log dir: {error}"))?;

        let mut child = Command::new(&self.config.katago_bin)
            .arg("gtp")
            .arg("-config")
            .arg(katago_config)
            .arg("-model")
            .arg(katago_model)
            .arg("-override-config")
            .arg(&self.config.override_config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("Failed to start KataGo: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture KataGo stdout".to_string())?;
        self.process = Some(KataGoProcess {
            child,
            stdout: BufReader::new(stdout),
        });
        Ok(())
    }

    fn send_gtp(&mut self, command: &str) -> Result<String, String> {
        self.ensure_started()?;
        let process = self
            .process
            .as_mut()
            .ok_or_else(|| "KataGo process is unavailable".to_string())?;
        let stdin = process
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "KataGo stdin is unavailable".to_string())?;

        stdin
            .write_all(command.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to write to KataGo: {error}"))?;

        read_gtp_response(process)
    }

    fn setup_position(&mut self, state: &GameStatePayload, komi: f64) -> Result<(), String> {
        validate_state(state)?;
        let board_size = state.board_size;
        let komi = if komi.is_finite() { komi } else { 6.5 };

        self.send_gtp(&format!("boardsize {board_size}"))?;
        self.send_gtp("clear_board")?;
        self.send_gtp(&format!("komi {komi}"))?;

        for position in get_handicap_positions(board_size, state.handicap.unwrap_or(0)) {
            self.send_gtp(&format!(
                "play B {}",
                to_gtp_coord(Some(position), board_size)?
            ))?;
        }

        for move_record in &state.move_records {
            let color = to_gtp_color(&move_record.player)?;
            let coord = to_gtp_coord(move_record.position, board_size)?;
            self.send_gtp(&format!("play {color} {coord}"))?;
        }

        Ok(())
    }

    fn get_move(
        &mut self,
        state: &GameStatePayload,
        komi: f64,
        difficulty: &str,
    ) -> Result<Value, String> {
        self.setup_position(state, komi)?;
        let difficulty_config = move_difficulty_config(difficulty);
        if difficulty_config.duration_ms > 0 {
            let analysis = self.get_analysis(state, komi, difficulty_config.duration_ms)?;
            if let Some(selected_move) = pick_analysis_move(&analysis.moves, difficulty_config) {
                return Ok(parsed_move_to_json(parse_gtp_move(
                    &selected_move.gtp_move,
                    state.board_size,
                )?));
            }
        }

        let raw_move =
            self.send_gtp(&format!("genmove {}", to_gtp_color(&state.current_player)?))?;
        let first_token = raw_move.split_whitespace().next().unwrap_or("pass");
        Ok(parsed_move_to_json(parse_gtp_move(
            first_token,
            state.board_size,
        )?))
    }

    fn get_analysis(
        &mut self,
        state: &GameStatePayload,
        komi: f64,
        duration_ms: u64,
    ) -> Result<AnalysisResult, String> {
        self.setup_position(state, komi)?;
        self.ensure_started()?;
        let process = self
            .process
            .as_mut()
            .ok_or_else(|| "KataGo process is unavailable".to_string())?;
        let stdin = process
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "KataGo stdin is unavailable".to_string())?;

        stdin
            .write_all(
                format!("kata-analyze {} 10\n", to_gtp_color(&state.current_player)?).as_bytes(),
            )
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to start KataGo analysis: {error}"))?;

        thread::sleep(Duration::from_millis(duration_ms.clamp(100, 10_000)));

        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to stop KataGo analysis: {error}"))?;

        let raw_stdout = read_gtp_response(process)?;
        Ok(AnalysisResult {
            current_player: state.current_player.clone(),
            moves: parse_analysis(&raw_stdout, state.board_size),
        })
    }
}

impl Drop for KataGoBridge {
    fn drop(&mut self) {
        if let Some(process) = self.process.as_mut() {
            let _ = process.child.kill();
        }
    }
}

fn read_gtp_response(process: &mut KataGoProcess) -> Result<String, String> {
    let mut raw = String::new();

    loop {
        let mut line = String::new();
        let bytes = process
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read from KataGo: {error}"))?;
        if bytes == 0 {
            return Err("KataGo exited".to_string());
        }

        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }

        raw.push_str(line);
        raw.push('\n');
    }

    let raw = raw.trim();
    if raw.starts_with('?') {
        return Err(raw.to_string());
    }
    Ok(raw.trim_start_matches('=').trim().to_string())
}

#[derive(Deserialize)]
struct MovePayload {
    state: GameStatePayload,
    komi: Option<f64>,
    difficulty: Option<String>,
}

#[derive(Deserialize)]
struct AnalysisPayload {
    state: GameStatePayload,
    komi: Option<f64>,
    #[serde(rename = "durationMs")]
    duration_ms: Option<u64>,
}

#[derive(Deserialize)]
struct GameStatePayload {
    #[serde(rename = "boardSize")]
    board_size: usize,
    #[serde(rename = "currentPlayer")]
    current_player: String,
    #[serde(rename = "moveRecords")]
    move_records: Vec<MoveRecordPayload>,
    handicap: Option<i64>,
}

#[derive(Deserialize)]
struct MoveRecordPayload {
    player: String,
    position: Option<Position>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Position {
    row: usize,
    col: usize,
}

#[derive(Serialize)]
struct AnalysisResult {
    #[serde(rename = "currentPlayer")]
    current_player: String,
    moves: Vec<AnalysisMove>,
}

#[derive(Serialize)]
struct AnalysisMove {
    position: Option<Position>,
    #[serde(rename = "gtpMove")]
    gtp_move: String,
    visits: i64,
    winrate: f64,
    #[serde(rename = "scoreLead")]
    score_lead: f64,
    pv: Vec<String>,
}

#[derive(Clone, Copy)]
struct MoveDifficultyConfig {
    duration_ms: u64,
    top_n: usize,
    temperature: f64,
}

fn move_difficulty_config(difficulty: &str) -> MoveDifficultyConfig {
    match difficulty {
        "beginner" => MoveDifficultyConfig {
            duration_ms: 180,
            top_n: 8,
            temperature: 1.4,
        },
        "advanced" => MoveDifficultyConfig {
            duration_ms: 650,
            top_n: 3,
            temperature: 0.45,
        },
        "strongest" => MoveDifficultyConfig {
            duration_ms: 0,
            top_n: 1,
            temperature: 0.0,
        },
        _ => MoveDifficultyConfig {
            duration_ms: 350,
            top_n: 5,
            temperature: 0.9,
        },
    }
}

fn random_unit() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    f64::from(nanos) / 1_000_000_000.0
}

fn pick_analysis_move<'a>(
    moves: &'a [AnalysisMove],
    config: MoveDifficultyConfig,
) -> Option<&'a AnalysisMove> {
    let candidates: Vec<&AnalysisMove> = moves
        .iter()
        .filter(|item| !item.gtp_move.eq_ignore_ascii_case("resign"))
        .take(config.top_n)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 || config.temperature <= 0.0 {
        return candidates.first().copied();
    }

    let weights: Vec<f64> = candidates
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let visits = item.visits.max(1) as f64;
            visits.powf(config.temperature) / (index + 1) as f64
        })
        .collect();
    let total: f64 = weights.iter().sum();
    let mut target = random_unit() * total;
    for (index, weight) in weights.iter().enumerate() {
        target -= weight;
        if target <= 0.0 {
            return candidates.get(index).copied();
        }
    }
    candidates.first().copied()
}

enum ParsedGtpMove {
    Position(Position),
    Pass,
    Resign,
}

fn validate_state(state: &GameStatePayload) -> Result<(), String> {
    if !matches!(state.board_size, 9 | 13 | 19) {
        return Err("Unsupported board size".to_string());
    }
    to_gtp_color(&state.current_player)?;
    for move_record in &state.move_records {
        to_gtp_color(&move_record.player)?;
        if let Some(position) = move_record.position {
            validate_position(position, state.board_size)?;
        }
    }
    Ok(())
}

fn validate_position(position: Position, board_size: usize) -> Result<(), String> {
    if position.row >= board_size || position.col >= board_size {
        return Err("Position is outside the board".to_string());
    }
    Ok(())
}

fn to_gtp_color(player: &str) -> Result<&'static str, String> {
    match player {
        "black" => Ok("B"),
        "white" => Ok("W"),
        _ => Err("Invalid player".to_string()),
    }
}

fn to_gtp_coord(position: Option<Position>, board_size: usize) -> Result<String, String> {
    let Some(position) = position else {
        return Ok("pass".to_string());
    };
    validate_position(position, board_size)?;
    let column = COLUMNS
        .chars()
        .nth(position.col)
        .ok_or_else(|| "Invalid column".to_string())?;
    Ok(format!("{column}{}", board_size - position.row))
}

fn parse_gtp_move(coord: &str, board_size: usize) -> Result<ParsedGtpMove, String> {
    let normalized = coord.trim().to_ascii_lowercase();
    if normalized == "pass" {
        return Ok(ParsedGtpMove::Pass);
    }
    if normalized == "resign" {
        return Ok(ParsedGtpMove::Resign);
    }

    let mut chars = coord.chars();
    let letter = chars
        .next()
        .ok_or_else(|| "Missing KataGo coordinate".to_string())?
        .to_ascii_uppercase();
    let col = COLUMNS
        .find(letter)
        .ok_or_else(|| format!("Invalid KataGo coordinate: {coord}"))?;
    let row_number = chars
        .as_str()
        .parse::<usize>()
        .map_err(|_| format!("Invalid KataGo coordinate: {coord}"))?;
    if row_number == 0 || row_number > board_size {
        return Err(format!("Invalid KataGo coordinate: {coord}"));
    }
    let row = board_size - row_number;
    if col >= board_size {
        return Err(format!("Invalid KataGo coordinate: {coord}"));
    }
    Ok(ParsedGtpMove::Position(Position { row, col }))
}

fn parsed_move_to_json(parsed: ParsedGtpMove) -> Value {
    match parsed {
        ParsedGtpMove::Position(position) => json!(position),
        ParsedGtpMove::Pass => Value::Null,
        ParsedGtpMove::Resign => json!("resign"),
    }
}

fn get_max_handicap_stones(board_size: usize) -> i64 {
    if board_size == 9 {
        5
    } else {
        9
    }
}

fn normalize_handicap(board_size: usize, handicap: i64) -> i64 {
    handicap.clamp(0, get_max_handicap_stones(board_size))
}

fn get_handicap_positions(board_size: usize, handicap: i64) -> Vec<Position> {
    let count = normalize_handicap(board_size, handicap);
    if count == 0 {
        return vec![];
    }

    let low = if board_size == 9 { 2 } else { 3 };
    let high = board_size - low - 1;
    let mid = board_size / 2;
    let center = Position { row: mid, col: mid };
    if count == 1 {
        return vec![center];
    }

    let corners = [
        Position {
            row: high,
            col: low,
        },
        Position {
            row: low,
            col: high,
        },
        Position {
            row: high,
            col: high,
        },
        Position { row: low, col: low },
    ];
    if count <= 4 {
        return corners[..count as usize].to_vec();
    }
    if count == 5 {
        return corners.into_iter().chain([center]).collect();
    }

    let side_points = [
        Position { row: mid, col: low },
        Position {
            row: mid,
            col: high,
        },
        Position { row: low, col: mid },
        Position {
            row: high,
            col: mid,
        },
    ];
    let mut positions = corners.to_vec();

    match count {
        6 => positions.extend_from_slice(&side_points[..2]),
        7 => {
            positions.extend_from_slice(&side_points[..2]);
            positions.push(center);
        }
        8 => positions.extend_from_slice(&side_points),
        _ => {
            positions.extend_from_slice(&side_points);
            positions.push(center);
        }
    }
    positions
}

fn parse_analysis(raw_stdout: &str, board_size: usize) -> Vec<AnalysisMove> {
    let Some(target_line) = raw_stdout
        .lines()
        .rev()
        .find(|line| line.contains("info move"))
    else {
        return vec![];
    };

    let mut moves = Vec::new();
    for raw in target_line
        .split("info ")
        .filter(|part| !part.trim().is_empty())
    {
        let tokens = raw.split_whitespace().collect::<Vec<_>>();
        if tokens.first() != Some(&"move") {
            continue;
        }

        let mut move_coord = None;
        let mut visits = 0i64;
        let mut winrate = 0.0f64;
        let mut score_lead = 0.0f64;
        let mut pv = Vec::new();
        let mut index = 0usize;

        while index < tokens.len() {
            match tokens[index] {
                "move" if index + 1 < tokens.len() => {
                    move_coord = Some(tokens[index + 1].to_string());
                    index += 2;
                }
                "visits" if index + 1 < tokens.len() => {
                    visits = tokens[index + 1].parse::<i64>().unwrap_or(0);
                    index += 2;
                }
                "winrate" if index + 1 < tokens.len() => {
                    winrate = tokens[index + 1].parse::<f64>().unwrap_or(0.0);
                    index += 2;
                }
                "scoreLead" if index + 1 < tokens.len() => {
                    score_lead = tokens[index + 1].parse::<f64>().unwrap_or(0.0);
                    index += 2;
                }
                "pv" => {
                    pv.extend(tokens[index + 1..].iter().map(|token| token.to_string()));
                    break;
                }
                _ => index += 1,
            }
        }

        let Some(gtp_move) = move_coord else {
            continue;
        };

        let position = match parse_gtp_move(&gtp_move, board_size) {
            Ok(ParsedGtpMove::Position(position)) => Some(position),
            Ok(ParsedGtpMove::Pass | ParsedGtpMove::Resign) | Err(_) => None,
        };
        let normalized_winrate = if winrate <= 1.0 && winrate > 0.0 {
            winrate * 100.0
        } else if winrate > 100.0 {
            winrate / 100.0
        } else {
            winrate
        };

        moves.push(AnalysisMove {
            position,
            gtp_move,
            visits,
            winrate: round2(normalized_winrate),
            score_lead: round2(score_lead),
            pv,
        });
    }

    moves.sort_by(|a, b| b.visits.cmp(&a.visits));
    moves
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
