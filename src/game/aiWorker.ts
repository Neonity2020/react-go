import type { AIDifficulty, GameState, Position, Stone } from './types';

type DifficultyConfig = {
  candidateLimit: number;
  simsByBoardSize: Record<number, number>;
  maxPlayoutByBoardSize: Record<number, number>;
  randomLegalChance: number;
  weightedCandidateChance: number;
  resignThreshold: number;
};

const DIFFICULTY_CONFIG: Record<AIDifficulty, DifficultyConfig> = {
  beginner: {
    candidateLimit: 12,
    simsByBoardSize: { 9: 8, 13: 5, 19: 3 },
    maxPlayoutByBoardSize: { 9: 20, 13: 24, 19: 28 },
    randomLegalChance: 0.22,
    weightedCandidateChance: 0.45,
    resignThreshold: 0,
  },
  normal: {
    candidateLimit: 8,
    simsByBoardSize: { 9: 40, 13: 20, 19: 10 },
    maxPlayoutByBoardSize: { 9: 40, 13: 50, 19: 60 },
    randomLegalChance: 0.04,
    weightedCandidateChance: 0.16,
    resignThreshold: 0.02,
  },
  advanced: {
    candidateLimit: 10,
    simsByBoardSize: { 9: 70, 13: 36, 19: 18 },
    maxPlayoutByBoardSize: { 9: 55, 13: 70, 19: 85 },
    randomLegalChance: 0.01,
    weightedCandidateChance: 0.06,
    resignThreshold: 0.015,
  },
  strongest: {
    candidateLimit: 12,
    simsByBoardSize: { 9: 110, 13: 56, 19: 28 },
    maxPlayoutByBoardSize: { 9: 70, 13: 90, 19: 110 },
    randomLegalChance: 0,
    weightedCandidateChance: 0,
    resignThreshold: 0.01,
  },
};

function getDifficultyConfig(difficulty: AIDifficulty | undefined): DifficultyConfig {
  return DIFFICULTY_CONFIG[difficulty ?? 'normal'] ?? DIFFICULTY_CONFIG.normal;
}

function getNeighbors(pos: Position, size: number): Position[] {
  const { row, col } = pos;
  const neighbors: Position[] = [];
  if (row > 0) neighbors.push({ row: row - 1, col });
  if (row < size - 1) neighbors.push({ row: row + 1, col });
  if (col > 0) neighbors.push({ row, col: col - 1 });
  if (col < size - 1) neighbors.push({ row, col: col + 1 });
  return neighbors;
}

function cloneBoard(board: (Stone | null)[][]): (Stone | null)[][] {
  return board.map(row => [...row]);
}

function getGroup(board: (Stone | null)[][], pos: Position, size: number): Position[] {
  const stone = board[pos.row][pos.col];
  if (!stone) return [];
  const visited = new Set<string>();
  const group: Position[] = [];
  const queue: Position[] = [pos];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const key = `${cur.row},${cur.col}`;
    if (visited.has(key)) continue;
    visited.add(key);
    group.push(cur);
    for (const nb of getNeighbors(cur, size)) {
      const nk = `${nb.row},${nb.col}`;
      if (!visited.has(nk) && board[nb.row][nb.col] === stone) queue.push(nb);
    }
  }
  return group;
}

function getLiberties(board: (Stone | null)[][], group: Position[], size: number): number {
  const libs = new Set<string>();
  for (const pos of group) {
    for (const nb of getNeighbors(pos, size)) {
      if (board[nb.row][nb.col] === null) libs.add(`${nb.row},${nb.col}`);
    }
  }
  return libs.size;
}

function simulateMove(board: (Stone | null)[][], pos: Position, player: Stone, size: number): { newBoard: (Stone | null)[][]; captured: number } {
  const newBoard = cloneBoard(board);
  newBoard[pos.row][pos.col] = player;
  const opponent: Stone = player === 'black' ? 'white' : 'black';
  let captured = 0;
  for (const nb of getNeighbors(pos, size)) {
    if (newBoard[nb.row][nb.col] === opponent) {
      const group = getGroup(newBoard, nb, size);
      if (getLiberties(newBoard, group, size) === 0) {
        captured += group.length;
        for (const p of group) newBoard[p.row][p.col] = null;
      }
    }
  }
  const ownGroup = getGroup(newBoard, pos, size);
  if (getLiberties(newBoard, ownGroup, size) === 0) return { newBoard: board, captured: -1 };
  return { newBoard, captured };
}

function isValidMove(board: (Stone | null)[][], pos: Position, player: Stone, size: number, koPoint: Position | null): boolean {
  if (board[pos.row][pos.col] !== null) return false;
  if (koPoint && koPoint.row === pos.row && koPoint.col === pos.col) return false;
  return simulateMove(board, pos, player, size).captured >= 0;
}

function getAllLegalMoves(board: (Stone | null)[][], player: Stone, size: number, koPoint: Position | null): Position[] {
  const moves: Position[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isValidMove(board, { row: r, col: c }, player, size, koPoint)) moves.push({ row: r, col: c });
    }
  }
  return moves;
}

function estimateScore(board: (Stone | null)[][], size: number): number {
  const visited = new Set<string>();
  let blackTerritory = 0, whiteTerritory = 0, blackStones = 0, whiteStones = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === 'black') blackStones++;
      else if (board[r][c] === 'white') whiteStones++;
    }
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const key = `${r},${c}`;
      if (board[r][c] !== null || visited.has(key)) continue;
      const region: Position[] = [];
      const borders = new Set<Stone>();
      const queue: Position[] = [{ row: r, col: c }];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        const ck = `${cur.row},${cur.col}`;
        if (visited.has(ck)) continue;
        const stone = board[cur.row][cur.col];
        if (stone !== null) { borders.add(stone); continue; }
        visited.add(ck);
        region.push(cur);
        for (const nb of getNeighbors(cur, size)) {
          if (!visited.has(`${nb.row},${nb.col}`)) queue.push(nb);
        }
      }
      if (borders.size === 1) {
        if (borders.has('black')) blackTerritory += region.length;
        else whiteTerritory += region.length;
      }
    }
  }
  return (blackStones + blackTerritory) - (whiteStones + whiteTerritory);
}

function playout(board: (Stone | null)[][], player: Stone, size: number, maxMoves: number): number {
  let current = player;
  let b = cloneBoard(board);
  let passCount = 0, moves = 0;
  while (passCount < 2 && moves < maxMoves) {
    const legal = getAllLegalMoves(b, current, size, null);
    if (legal.length === 0) { passCount++; }
    else {
      passCount = 0;
      const pos = legal[Math.floor(Math.random() * legal.length)];
      const { newBoard } = simulateMove(b, pos, current, size);
      b = newBoard;
    }
    current = current === 'black' ? 'white' : 'black';
    moves++;
  }
  return estimateScore(b, size);
}

function getCandidates(board: (Stone | null)[][], player: Stone, size: number, koPoint: Position | null, limit: number): Position[] {
  const legal = getAllLegalMoves(board, player, size, koPoint);
  const opponent: Stone = player === 'black' ? 'white' : 'black';
  const moveNumber = board.flat().filter(s => s !== null).length;

  const scored = legal.map(pos => {
    let p = 0;
    const sim = simulateMove(board, pos, player, size);
    if (sim.captured > 0) p += 50 + sim.captured * 20;
    for (const nb of getNeighbors(pos, size)) {
      if (board[nb.row][nb.col] === player) {
        const group = getGroup(board, nb, size);
        if (getLiberties(board, group, size) === 1) p += 40;
        else if (getLiberties(board, group, size) === 2) p += 10;
      }
    }
    if (sim.captured >= 0) {
      for (const nb of getNeighbors(pos, size)) {
        if (sim.newBoard[nb.row]?.[nb.col] === opponent) {
          const group = getGroup(sim.newBoard, nb, size);
          if (getLiberties(sim.newBoard, group, size) === 1) p += 25;
        }
      }
    }
    const edgeDist = Math.min(pos.row, pos.col, size - 1 - pos.row, size - 1 - pos.col);
    if (moveNumber < size * 4) {
      if (edgeDist === 0) p -= 8;
      else if (edgeDist >= 2 && edgeDist <= 4) p += 3;
    }
    let adj = 0;
    for (const nb of getNeighbors(pos, size)) { if (board[nb.row][nb.col] !== null) adj++; }
    if (adj === 1) p += 5;
    else if (adj >= 3) p -= 10;
    return { pos, p };
  });

  scored.sort((a, b) => b.p - a.p);
  const topN = Math.min(limit, scored.length);
  return scored.slice(0, topN).map(s => s.pos);
}

function getStarMoves(size: number): Position[] {
  if (size === 9) return [{ row:2,col:2 },{ row:2,col:6 },{ row:4,col:4 },{ row:6,col:2 },{ row:6,col:6 }];
  if (size === 13) return [{ row:3,col:3 },{ row:3,col:6 },{ row:3,col:9 },{ row:6,col:3 },{ row:6,col:6 },{ row:6,col:9 },{ row:9,col:3 },{ row:9,col:6 },{ row:9,col:9 }];
  return [{ row:3,col:3 },{ row:3,col:9 },{ row:3,col:15 },{ row:9,col:3 },{ row:9,col:9 },{ row:9,col:15 },{ row:15,col:3 },{ row:15,col:9 },{ row:15,col:15 }];
}

type AIResult = Position | 'resign' | null;

function pickWeightedCandidate(candidates: Position[]): Position {
  const weights = candidates.map((_, index) => 1 / (index + 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    target -= weights[i];
    if (target <= 0) return candidates[i];
  }
  return candidates[0];
}

function computeAIMove(state: GameState, difficulty?: AIDifficulty): AIResult {
  const { board, boardSize, currentPlayer, koPoint } = state;
  const config = getDifficultyConfig(difficulty);
  const legalMoves = getAllLegalMoves(board, currentPlayer, boardSize, koPoint);
  if (legalMoves.length === 0) return null;

  // Don't resign too early — need at least some moves to evaluate
  const minMovesBeforeResign = boardSize <= 9 ? 20 : boardSize <= 13 ? 30 : 40;

  if (state.history.length === 0) {
    const stars = getStarMoves(boardSize).filter(p => board[p.row][p.col] === null);
    if (stars.length > 0) return stars[Math.floor(Math.random() * stars.length)];
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  }

  const candidates = getCandidates(board, currentPlayer, boardSize, koPoint, config.candidateLimit);
  if (candidates.length === 0) return null;

  if (Math.random() < config.randomLegalChance) {
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  }

  if (Math.random() < config.weightedCandidateChance) {
    return pickWeightedCandidate(candidates);
  }

  const sims = config.simsByBoardSize[boardSize] ?? config.simsByBoardSize[19];
  const maxPlayout = config.maxPlayoutByBoardSize[boardSize] ?? config.maxPlayoutByBoardSize[19];
  const opponent: Stone = currentPlayer === 'black' ? 'white' : 'black';

  let bestPos = candidates[0];
  let bestWins = -1;
  let totalSims = 0;

  for (const pos of candidates) {
    const { newBoard, captured } = simulateMove(board, pos, currentPlayer, boardSize);
    if (captured < 0) continue;
    let wins = 0;
    for (let i = 0; i < sims; i++) {
      const score = playout(newBoard, opponent, boardSize, maxPlayout);
      if (currentPlayer === 'black' ? score > 0 : score < 0) wins++;
      totalSims++;
    }
    if (wins > bestWins) { bestWins = wins; bestPos = pos; }
  }

  // Resign if win rate is below 2% and enough moves have been played
  if (state.history.length >= minMovesBeforeResign && totalSims > 0) {
    const winRate = bestWins / sims;
    if (config.resignThreshold > 0 && winRate < config.resignThreshold) return 'resign';
  }

  return bestPos;
}

self.onmessage = (e: MessageEvent<{ id: number; state: GameState; difficulty?: AIDifficulty }>) => {
  const result = computeAIMove(e.data.state, e.data.difficulty);
  self.postMessage({ id: e.data.id, result });
};
