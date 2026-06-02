import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const port = Number(process.env.KATAGO_BRIDGE_PORT || 3107);

const katagoBin = process.env.KATAGO_BIN || '/opt/homebrew/bin/katago';
const katagoShare = process.env.KATAGO_SHARE || '/opt/homebrew/opt/katago/share/katago';
const modelCandidates = [
  process.env.KATAGO_MODEL,
  path.join(katagoShare, 'kata1-b18c384nbt-s9996604416-d4316597426.bin.gz'),
  path.join(katagoShare, 'g170e-b20c256x2-s5303129600-d1228401921.bin.gz'),
  path.join(katagoShare, 'g170-b40c256x2-s5095420928-d1229425124.bin.gz'),
].filter(Boolean);
const configCandidates = [
  process.env.KATAGO_CONFIG,
  path.join(katagoShare, 'configs/gtp_example.cfg'),
].filter(Boolean);

const katagoModel = modelCandidates.find(candidate => existsSync(candidate));
const katagoConfig = configCandidates.find(candidate => existsSync(candidate));
const logDir = path.join(projectRoot, 'server/katago_logs');
const overrideConfig = process.env.KATAGO_OVERRIDE_CONFIG ||
  `maxVisits=96,numSearchThreads=4,ponderingEnabled=false,allowResignation=false,logDir=${logDir},logAllGTPCommunication=false,logSearchInfo=false,logToStderr=false`;

const columns = 'ABCDEFGHJKLMNOPQRST';
let katagoProcess = null;
let stdoutBuffer = '';
const pendingResponses = [];

// Request queue to serialize KataGo process access and prevent race conditions
let requestQueue = Promise.resolve();

function enqueue(task) {
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue
      .then(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      })
      .catch(() => {}); // prevent queue from breaking on errors
  });
}

function ensureLogDir() {
  mkdirSync(logDir, { recursive: true });
}

function toGtpColor(player) {
  return player === 'black' ? 'B' : 'W';
}

function toGtpCoord(position, boardSize) {
  if (!position) return 'pass';
  return `${columns[position.col]}${boardSize - position.row}`;
}

function getMaxHandicapStones(boardSize) {
  return boardSize === 9 ? 5 : 9;
}

function normalizeHandicap(boardSize, handicap) {
  if (!Number.isFinite(handicap)) return 0;
  const rounded = Math.round(handicap);
  return Math.min(Math.max(rounded, 0), getMaxHandicapStones(boardSize));
}

function getHandicapPositions(boardSize, handicap) {
  const count = normalizeHandicap(boardSize, handicap);
  if (count === 0) return [];

  const low = boardSize === 9 ? 2 : 3;
  const high = boardSize - low - 1;
  const mid = Math.floor(boardSize / 2);

  const center = { row: mid, col: mid };
  if (count === 1) return [center];

  const corners = [
    { row: high, col: low },
    { row: low, col: high },
    { row: high, col: high },
    { row: low, col: low },
  ];

  if (count <= 4) return corners.slice(0, count);
  if (count === 5) return [...corners, center];

  const sidePoints = [
    { row: mid, col: low },
    { row: mid, col: high },
    { row: low, col: mid },
    { row: high, col: mid },
  ];

  if (count === 6) return [...corners, ...sidePoints.slice(0, 2)];
  if (count === 7) return [...corners, ...sidePoints.slice(0, 2), center];
  if (count === 8) return [...corners, ...sidePoints];
  return [...corners, ...sidePoints, center];
}

function fromGtpCoord(coord, boardSize) {
  const normalized = coord.trim().toLowerCase();
  if (normalized === 'pass') return null;
  if (normalized === 'resign') return 'resign';

  const letter = coord[0].toUpperCase();
  const col = columns.indexOf(letter);
  const rowNumber = Number(coord.slice(1));
  const row = boardSize - rowNumber;

  if (col < 0 || col >= boardSize || !Number.isInteger(row) || row < 0 || row >= boardSize) {
    throw new Error(`Invalid KataGo coordinate: ${coord}`);
  }

  return { row, col };
}

function parseResponses() {
  let boundary = stdoutBuffer.indexOf('\n\n');
  while (boundary !== -1) {
    const raw = stdoutBuffer.slice(0, boundary).trim();
    stdoutBuffer = stdoutBuffer.slice(boundary + 2);
    const pending = pendingResponses.shift();
    if (pending) {
      pending.finish(raw);
    }
    boundary = stdoutBuffer.indexOf('\n\n');
  }
}

function startKataGo() {
  if (katagoProcess) return;
  if (!existsSync(katagoBin)) throw new Error(`KataGo binary not found: ${katagoBin}`);
  if (!katagoModel) throw new Error('KataGo model not found. Set KATAGO_MODEL to a .bin.gz model path.');
  if (!katagoConfig) throw new Error('KataGo config not found. Set KATAGO_CONFIG to a gtp config path.');

  ensureLogDir();
  katagoProcess = spawn(katagoBin, [
    'gtp',
    '-config',
    katagoConfig,
    '-model',
    katagoModel,
    '-override-config',
    overrideConfig,
  ], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  katagoProcess.stdout.setEncoding('utf8');
  katagoProcess.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    parseResponses();
  });

  katagoProcess.stderr.setEncoding('utf8');
  katagoProcess.stderr.on('data', chunk => {
    const text = chunk.trim();
    if (text) console.error(`[katago] ${text}`);
  });

  katagoProcess.on('exit', (code, signal) => {
    katagoProcess = null;
    stdoutBuffer = '';
    const error = new Error(`KataGo exited (${code ?? signal})`);
    while (pendingResponses.length > 0) {
      pendingResponses.shift()?.reject(error);
    }
  });
}

function sendGtp(command, timeoutMs = 60_000) {
  startKataGo();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for KataGo: ${command}`));
    }, timeoutMs);

    pendingResponses.push({
      finish(raw) {
        clearTimeout(timer);
        if (raw.startsWith('?')) {
          reject(new Error(raw));
          return;
        }
        resolve(raw.replace(/^=\s*/, '').trim());
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });

    katagoProcess.stdin.write(`${command}\n`);
  });
}

const MOVE_DIFFICULTY_CONFIG = {
  beginner: { durationMs: 180, topN: 8, temperature: 1.4 },
  normal: { durationMs: 350, topN: 5, temperature: 0.9 },
  advanced: { durationMs: 650, topN: 3, temperature: 0.45 },
  strongest: { durationMs: 0, topN: 1, temperature: 0 },
};

const RESIGN_CONFIG = {
  minWinrate: 2.5,
  minMoveFractions: { 9: 0.22, 13: 0.18, 19: 0.16 },
  scoreDeficits: { 9: 18, 13: 35, 19: 65 },
};

function getMoveDifficultyConfig(difficulty) {
  return MOVE_DIFFICULTY_CONFIG[difficulty] ?? MOVE_DIFFICULTY_CONFIG.normal;
}

function positionKey(position) {
  return `${position.row},${position.col}`;
}

function getNeighbors(pos, size) {
  const neighbors = [];
  if (pos.row > 0) neighbors.push({ row: pos.row - 1, col: pos.col });
  if (pos.row < size - 1) neighbors.push({ row: pos.row + 1, col: pos.col });
  if (pos.col > 0) neighbors.push({ row: pos.row, col: pos.col - 1 });
  if (pos.col < size - 1) neighbors.push({ row: pos.row, col: pos.col + 1 });
  return neighbors;
}

function getGroup(board, pos, size) {
  const stone = board[pos.row]?.[pos.col];
  if (!stone) return [];

  const visited = new Set();
  const group = [];
  const queue = [pos];
  while (queue.length > 0) {
    const current = queue.pop();
    const key = positionKey(current);
    if (visited.has(key)) continue;
    visited.add(key);
    group.push(current);
    for (const neighbor of getNeighbors(current, size)) {
      if (!visited.has(positionKey(neighbor)) && board[neighbor.row]?.[neighbor.col] === stone) {
        queue.push(neighbor);
      }
    }
  }
  return group;
}

function getLiberties(board, group, size) {
  const liberties = new Set();
  for (const pos of group) {
    for (const neighbor of getNeighbors(pos, size)) {
      if (board[neighbor.row]?.[neighbor.col] === null) {
        liberties.add(positionKey(neighbor));
      }
    }
  }
  return liberties.size;
}

function isLegalPosition(state, position) {
  const boardSize = state?.boardSize;
  const board = state?.board;
  const currentPlayer = state?.currentPlayer;
  if (!position) return true;
  if (!Array.isArray(board) || ![9, 13, 19].includes(boardSize)) return true;
  if (position.row < 0 || position.row >= boardSize || position.col < 0 || position.col >= boardSize) return false;
  if (board[position.row]?.[position.col] !== null) return false;
  if (state?.koPoint?.row === position.row && state?.koPoint?.col === position.col) return false;

  const newBoard = board.map(row => [...row]);
  newBoard[position.row][position.col] = currentPlayer;
  const opponent = currentPlayer === 'black' ? 'white' : 'black';

  let captured = 0;
  for (const neighbor of getNeighbors(position, boardSize)) {
    if (newBoard[neighbor.row][neighbor.col] === opponent) {
      const group = getGroup(newBoard, neighbor, boardSize);
      if (getLiberties(newBoard, group, boardSize) === 0) {
        captured += group.length;
        for (const stone of group) newBoard[stone.row][stone.col] = null;
      }
    }
  }

  if (captured === 0) {
    const ownGroup = getGroup(newBoard, position, boardSize);
    return getLiberties(newBoard, ownGroup, boardSize) > 0;
  }
  return true;
}

function legalAnalysisMoves(moves, state) {
  return moves.filter(move => move.position === null || isLegalPosition(state, move.position));
}

function currentPlayerScoreLead(move, currentPlayer) {
  return currentPlayer === 'black' ? move.scoreLead : -move.scoreLead;
}

function shouldResignFromAnalysis(analysis, state) {
  const bestMove = analysis.moves[0];
  if (!bestMove) return false;
  const boardSize = state.boardSize;
  const minMoves = Math.ceil(boardSize * boardSize * (RESIGN_CONFIG.minMoveFractions[boardSize] ?? 0.18));
  if (state.moveRecords.length < minMoves) return false;
  if (bestMove.winrate > RESIGN_CONFIG.minWinrate) return false;
  return currentPlayerScoreLead(bestMove, state.currentPlayer) <= -(RESIGN_CONFIG.scoreDeficits[boardSize] ?? 50);
}

function pickAnalysisMove(moves, config, state) {
  const candidates = moves
    .filter(move => move.gtpMove && move.gtpMove.toLowerCase() !== 'resign')
    .filter(move => move.position === null || isLegalPosition(state, move.position))
    .slice(0, config.topN);
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || config.temperature <= 0) return candidates[0];

  const weights = candidates.map((move, index) => {
    const visits = Math.max(1, move.visits || 1);
    return Math.pow(visits, config.temperature) / (index + 1);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    target -= weights[i];
    if (target <= 0) return candidates[i];
  }
  return candidates[0];
}

async function getMove(state, komi, difficulty = 'normal') {
  const boardSize = state?.boardSize;
  const currentPlayer = state?.currentPlayer;
  const moves = state?.moveRecords;
  if (![9, 13, 19].includes(boardSize)) throw new Error('Unsupported board size');
  if (currentPlayer !== 'black' && currentPlayer !== 'white') throw new Error('Invalid current player');
  if (!Array.isArray(moves)) throw new Error('Invalid move records');

  await sendGtp(`boardsize ${boardSize}`);
  await sendGtp('clear_board');
  await sendGtp(`komi ${Number.isFinite(komi) ? komi : 6.5}`);

  for (const position of getHandicapPositions(boardSize, state?.handicap ?? 0)) {
    await sendGtp(`play B ${toGtpCoord(position, boardSize)}`);
  }

  for (const move of moves) {
    await sendGtp(`play ${toGtpColor(move.player)} ${toGtpCoord(move.position, boardSize)}`);
  }

  const difficultyConfig = getMoveDifficultyConfig(difficulty);
  if (difficultyConfig !== MOVE_DIFFICULTY_CONFIG.strongest) {
    const analysis = await getAnalysis(state, komi, difficultyConfig.durationMs);
    if (shouldResignFromAnalysis(analysis, state)) return 'resign';
    const selectedMove = pickAnalysisMove(analysis.moves, difficultyConfig, state);
    if (selectedMove) return fromGtpCoord(selectedMove.gtpMove, boardSize);
  }

  if (difficultyConfig === MOVE_DIFFICULTY_CONFIG.strongest) {
    const analysis = await getAnalysis(state, komi, 700);
    if (shouldResignFromAnalysis(analysis, state)) return 'resign';
  }

  const rawMove = await sendGtp(`genmove ${toGtpColor(currentPlayer)}`, 120_000);
  const move = fromGtpCoord(rawMove.split(/\s+/)[0], boardSize);
  return move === 'resign' || move === null || isLegalPosition(state, move) ? move : null;
}

function parseAnalysis(rawStdout, boardSize) {
  const lines = rawStdout.split('\n');
  let targetLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('info move')) {
      targetLine = lines[i];
      break;
    }
  }

  if (!targetLine) {
    return [];
  }

  const movesRaw = targetLine.split(/\binfo\s+/).filter(Boolean);
  const moves = [];

  for (const raw of movesRaw) {
    if (!raw.trim().startsWith('move')) continue;

    const tokens = raw.trim().split(/\s+/);
    let moveCoord = null;
    let visits = 0;
    let winrate = 0;
    let scoreLead = 0;
    const pv = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === 'move' && i + 1 < tokens.length) {
        moveCoord = tokens[i + 1];
        i++;
      } else if (token === 'visits' && i + 1 < tokens.length) {
        visits = parseInt(tokens[i + 1], 10);
        i++;
      } else if (token === 'winrate' && i + 1 < tokens.length) {
        winrate = parseFloat(tokens[i + 1]);
        i++;
      } else if (token === 'scoreLead' && i + 1 < tokens.length) {
        scoreLead = parseFloat(tokens[i + 1]);
        i++;
      } else if (token === 'pv') {
        for (let j = i + 1; j < tokens.length; j++) {
          pv.push(tokens[j]);
        }
        break;
      }
    }

    if (moveCoord) {
      let position = null;
      try {
        position = fromGtpCoord(moveCoord, boardSize);
      } catch (e) {
        // Keep position as null
      }

      let normalizedWinrate = winrate;
      if (normalizedWinrate <= 1.0 && normalizedWinrate > 0) {
        normalizedWinrate = normalizedWinrate * 100;
      } else if (normalizedWinrate > 100) {
        normalizedWinrate = normalizedWinrate / 100;
      }

      moves.push({
        position,
        gtpMove: moveCoord,
        visits,
        winrate: Number(normalizedWinrate.toFixed(2)),
        scoreLead: Number(scoreLead.toFixed(2)),
        pv,
      });
    }
  }

  moves.sort((a, b) => b.visits - a.visits);
  return moves;
}

async function getAnalysis(state, komi, durationMs = 800) {
  const boardSize = state?.boardSize;
  const currentPlayer = state?.currentPlayer;
  const moves = state?.moveRecords;
  if (![9, 13, 19].includes(boardSize)) throw new Error('Unsupported board size');
  if (currentPlayer !== 'black' && currentPlayer !== 'white') throw new Error('Invalid current player');
  if (!Array.isArray(moves)) throw new Error('Invalid move records');

  await sendGtp(`boardsize ${boardSize}`);
  await sendGtp('clear_board');
  await sendGtp(`komi ${Number.isFinite(komi) ? komi : 6.5}`);

  for (const position of getHandicapPositions(boardSize, state?.handicap ?? 0)) {
    await sendGtp(`play B ${toGtpCoord(position, boardSize)}`);
  }

  for (const move of moves) {
    await sendGtp(`play ${toGtpColor(move.player)} ${toGtpCoord(move.position, boardSize)}`);
  }

  let rawStdout = '';
  const onData = (chunk) => {
    rawStdout += chunk;
  };

  katagoProcess?.stdout?.on('data', onData);

  try {
    const analysisPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Analysis timed out'));
      }, durationMs + 2000);

      pendingResponses.push({
        finish(raw) {
          clearTimeout(timer);
          resolve(rawStdout);
        },
        reject(err) {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    katagoProcess.stdin.write(`kata-analyze ${toGtpColor(currentPlayer)} 10\n`);

    await new Promise(resolve => setTimeout(resolve, durationMs));

    katagoProcess.stdin.write('\n');

    const resultRaw = await analysisPromise;
    const analyzedMoves = legalAnalysisMoves(parseAnalysis(resultRaw, boardSize), state);
    return {
      currentPlayer,
      moves: analyzedMoves,
    };
  } finally {
    katagoProcess?.stdout?.off('data', onData);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, {
        ok: Boolean(existsSync(katagoBin) && katagoModel && katagoConfig),
        running: Boolean(katagoProcess),
        katagoBin,
        katagoModel,
        katagoConfig,
        port,
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/move') {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      const result = await enqueue(() => getMove(payload.state, Number(payload.komi), payload.difficulty));
      sendJson(response, 200, { engine: 'katago', result });
      return;
    }

    if (request.method === 'POST' && request.url === '/analyze') {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      const result = await enqueue(() => getAnalysis(payload.state, Number(payload.komi), Number(payload.durationMs || 800)));
      sendJson(response, 200, { ok: true, analysis: result });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`KataGo bridge listening on http://127.0.0.1:${port}`);
  console.log(`KataGo model: ${katagoModel || '(not found)'}`);
  console.log(`KataGo config: ${katagoConfig || '(not found)'}`);
});

process.on('SIGINT', () => {
  katagoProcess?.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  katagoProcess?.kill();
  process.exit(0);
});
