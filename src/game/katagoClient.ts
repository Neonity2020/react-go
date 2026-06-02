import type { GameState, Position, AnalysisResult, AIDifficulty } from './types';
import { isValidMove } from './engine';

export type KataGoMoveResult = Position | 'resign' | null;
export type KataGoSetupStatus = {
  ok: boolean;
  running: boolean;
  katagoBin?: string;
  katagoModel?: string;
  katagoConfig?: string;
  installDir: string;
  message: string;
};

type TauriInternals = {
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3107';

function bridgeUrl() {
  return (import.meta.env.VITE_KATAGO_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/$/, '');
}

function isPosition(value: unknown): value is Position {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isInteger((value as Position).row) &&
    Number.isInteger((value as Position).col)
  );
}

function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    throw new Error('Tauri runtime is unavailable');
  }
  return invoke<T>(command, args);
}

export async function getKataGoSetupStatus(): Promise<KataGoSetupStatus> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return tauriInvoke<KataGoSetupStatus>('katago_setup_status');
  }

  const response = await fetch(`${bridgeUrl()}/health`);
  if (!response.ok) {
    throw new Error(`KataGo bridge returned ${response.status}`);
  }
  return response.json() as Promise<KataGoSetupStatus>;
}

export async function installKataGoRuntime(): Promise<KataGoSetupStatus> {
  return tauriInvoke<KataGoSetupStatus>('install_katago_runtime');
}

export async function getKataGoMove(state: GameState, komi: number, difficulty: AIDifficulty = 'normal'): Promise<KataGoMoveResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(`${bridgeUrl()}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, komi, difficulty }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`KataGo bridge returned ${response.status}`);
    }

    const data = await response.json() as { result?: unknown };
    if (data.result === 'resign') return 'resign';
    if (data.result === null || typeof data.result === 'undefined') return null;
    if (isPosition(data.result)) {
      if (!isValidMove(state, data.result)) {
        throw new Error('KataGo bridge returned an illegal move');
      }
      return data.result;
    }
    throw new Error('KataGo bridge returned an invalid move');
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function getKataGoAnalysis(state: GameState, komi: number, durationMs = 800): Promise<AnalysisResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${bridgeUrl()}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, komi, durationMs }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`KataGo bridge returned ${response.status}`);
    }

    const data = await response.json() as { ok: boolean; analysis?: AnalysisResult; error?: string };
    if (data.error) {
      throw new Error(data.error);
    }
    if (data.ok && data.analysis) {
      return {
        ...data.analysis,
        moves: data.analysis.moves.filter(move => !move.position || isValidMove(state, move.position)),
      };
    }
    throw new Error('KataGo bridge returned invalid analysis data');
  } finally {
    window.clearTimeout(timeout);
  }
}
