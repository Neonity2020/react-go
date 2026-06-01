export type Stone = 'black' | 'white';
export type Position = { row: number; col: number };
export type AIDifficulty = 'beginner' | 'normal' | 'advanced' | 'strongest';

export interface MoveRecord {
  moveNumber: number;
  player: Stone;
  position: Position | null; // null = pass
  captures: number; // stones captured this move
  winrate?: number; // winrate for this move (0-100)
  scoreLead?: number; // estimated score lead (positive = black leads, negative = white leads)
}

export interface AnalysisMove {
  position: Position | null;
  gtpMove: string;
  visits: number;
  winrate: number;
  scoreLead: number;
  pv: string[];
}

export interface AnalysisResult {
  currentPlayer: Stone;
  moves: AnalysisMove[];
}

export interface ScoreResult {
  blackTerritory: number;
  whiteTerritory: number;
  blackStones: number;
  whiteStones: number;
  blackCaptures: number;
  whiteCaptures: number;
  blackTotal: number;
  whiteTotal: number;
  komi: number;
  winner: Stone | 'tie';
}

export interface SavedGame {
  id: string;
  date: string;
  boardSize: number;
  gameMode: 'pvp' | 'pve';
  handicap?: number;
  komi: number;
  winner: Stone | 'tie';
  scoreResult: ScoreResult;
  moveRecords: MoveRecord[];
  winRateHistory?: { moveNumber: number; blackWinrate: number }[];
}

export interface GameState {
  boardSize: number;
  handicap: number;
  board: (Stone | null)[][];
  currentPlayer: Stone;
  captures: { black: number; white: number };
  history: (Stone | null)[][][];
  capturesHistory: { black: number; white: number }[];
  koPoint: Position | null;
  passCount: number;
  gameOver: boolean;
  lastMove: Position | null;
  moveRecords: MoveRecord[];
}
