import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Board from './Board';
import type { GameState, MoveRecord, Position, ScoreResult, Stone, AnalysisResult, AnalysisMove, SavedGame, AIDifficulty } from '../game/types';
import { calculateScore, createInitialState, getMaxHandicapStones, isValidMove, normalizeHandicap, pass, placeStone, resign, undo } from '../game/engine';
import { getKataGoMove, getKataGoAnalysis, getKataGoSetupStatus, installKataGoRuntime, type KataGoSetupStatus } from '../game/katagoClient';
import { playStoneSound, playCaptureSound, startBgm, stopBgm } from '../game/audio';

type GameMode = 'pvp' | 'pve';
type AIEngine = 'katago' | 'browser';
type AIResult = Position | 'resign' | null;
type AIWorkerResponse = { id: number; result: AIResult };
type NigiriGuess = 'odd' | 'even';
type NigiriState =
  | { status: 'idle' }
  | { status: 'pending'; hiddenStones: number }
  | { status: 'revealed'; hiddenStones: number; guess: NigiriGuess; correct: boolean; humanColor: Stone };

const BOARD_SIZES = [9, 13, 19] as const;
const DEFAULT_KOMI = 6.5;
const BOARD_LETTERS = 'ABCDEFGHJKLMNOPQRST';
const AI_DIFFICULTIES: { value: AIDifficulty; label: string }[] = [
  { value: 'beginner', label: '入门' },
  { value: 'normal', label: '普通' },
  { value: 'advanced', label: '进阶' },
  { value: 'strongest', label: '最强' },
];

const STORAGE_KEY = 'go_game_history';

function reconstructGameState(savedGame: SavedGame, stepNum: number): GameState {
  let state = createInitialState(savedGame.boardSize, savedGame.handicap ?? 0);
  for (let i = 0; i < stepNum; i++) {
    const record = savedGame.moveRecords[i];
    if (record.position) {
      state = placeStone(state, record.position);
    } else {
      state = pass(state);
    }
  }
  return state;
}

function createNigiri(): NigiriState {
  return {
    status: 'pending',
    hiddenStones: Math.floor(Math.random() * 10) + 1,
  };
}

function opponentOf(player: Stone): Stone {
  return player === 'black' ? 'white' : 'black';
}

function playerLabel(player: Stone, gameMode: GameMode, humanColor: Stone) {
  if (gameMode === 'pve') return player === humanColor ? '你' : 'AI';
  return player === 'black' ? '黑方' : '白方';
}

function colorLabel(player: Stone) {
  return player === 'black' ? '黑' : '白';
}

function guessLabel(guess: NigiriGuess) {
  return guess === 'odd' ? '单数' : '双数';
}

function formatMove(record: MoveRecord, boardSize: number) {
  if (!record.position) return '虚手';
  const col = BOARD_LETTERS[record.position.col] ?? String(record.position.col + 1);
  return `${col}${boardSize - record.position.row}`;
}

function formatWinner(score: ScoreResult, gameMode: GameMode, humanColor: Stone) {
  if (score.winner === 'tie') return '平局';
  return `${playerLabel(score.winner, gameMode, humanColor)}领先`;
}

function scoreLead(score: ScoreResult) {
  const diff = Math.abs(score.blackTotal - score.whiteTotal);
  return diff.toFixed(1);
}

function aiEngineLabel(engine: AIEngine) {
  return engine === 'katago' ? 'KataGo' : '本地 AI';
}

function aiDifficultyLabel(difficulty: AIDifficulty) {
  return AI_DIFFICULTIES.find(item => item.value === difficulty)?.label ?? '普通';
}

function handicapLabel(handicap: number) {
  return handicap > 0 ? `让${handicap}子` : '互先';
}

export default function GameApp() {
  const [gameState, setGameState] = useState<GameState>(createInitialState(19));
  const [gameMode, setGameMode] = useState<GameMode>('pvp');
  const [aiEngine, setAiEngine] = useState<AIEngine>('katago');
  const [aiDifficulty, setAiDifficulty] = useState<AIDifficulty>('normal');
  const [humanColor, setHumanColor] = useState<Stone>('black');
  const [nigiri, setNigiri] = useState<NigiriState>({ status: 'idle' });
  const [aiThinking, setAiThinking] = useState(false);
  const [katagoStatus, setKatagoStatus] = useState<KataGoSetupStatus | null>(null);
  const [katagoSetupLoading, setKatagoSetupLoading] = useState(false);
  const [komi, setKomi] = useState(DEFAULT_KOMI);
  const [notice, setNotice] = useState('');
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [hoveredAnalysisMove, setHoveredAnalysisMove] = useState<AnalysisMove | null>(null);
  const [winRateHistory, setWinRateHistory] = useState<{ moveNumber: number; blackWinrate: number }[]>([]);

  // Review mode states
  const [isReviewMode, setIsReviewMode] = useState(false);
  const [reviewGame, setReviewGame] = useState<SavedGame | null>(null);
  const [reviewStep, setReviewStep] = useState(0);
  const [trialState, setTrialState] = useState<GameState | null>(null);
  const [savedGames, setSavedGames] = useState<SavedGame[]>([]);
  const [hasSavedCurrentGame, setHasSavedCurrentGame] = useState(false);

  // Audio BGM states & handlers
  const [bgmPlaying, setBgmPlaying] = useState(false);

  const toggleBgm = useCallback(() => {
    setBgmPlaying(prev => {
      const next = !prev;
      if (next) {
        startBgm();
      } else {
        stopBgm();
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      stopBgm();
    };
  }, []);

  const refreshKataGoStatus = useCallback(() => {
    getKataGoSetupStatus()
      .then(setKatagoStatus)
      .catch(() => {
        setKatagoStatus({
          ok: false,
          running: false,
          installDir: '',
          message: 'KataGo Bridge 未连接',
        });
      });
  }, []);

  useEffect(() => {
    refreshKataGoStatus();
  }, [refreshKataGoStatus]);

  const handleInstallKataGo = useCallback(() => {
    setKatagoSetupLoading(true);
    setNotice('正在安装 KataGo AI 引擎，首次下载可能需要几分钟');
    installKataGoRuntime()
      .then(status => {
        setKatagoStatus(status);
        setAiEngine('katago');
        setNotice('KataGo AI 引擎已安装完成');
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        setNotice(`KataGo 安装失败：${message}`);
        refreshKataGoStatus();
      })
      .finally(() => setKatagoSetupLoading(false));
  }, [refreshKataGoStatus]);

  const { currentPlayer, gameOver, passCount, boardSize, moveRecords, handicap } = gameState;

  const nigiriPending = gameMode === 'pve' && handicap === 0 && nigiri.status === 'pending';
  const isAiTurn = gameMode === 'pve' && !nigiriPending && currentPlayer !== humanColor && !gameOver;

  // Reconstruct state at specific review step
  const reviewGameState = useMemo(() => {
    if (!reviewGame) return null;
    return reconstructGameState(reviewGame, reviewStep);
  }, [reviewGame, reviewStep]);

  // Derived state to display on the board & sidebar
  const currentViewedState = useMemo(() => {
    if (trialState) return trialState;
    if (isReviewMode && reviewGameState) return reviewGameState;
    return gameState;
  }, [isReviewMode, reviewGameState, trialState, gameState]);
  const viewedHandicap = currentViewedState.handicap ?? 0;
  const handicapOptions = useMemo(() => {
    const max = getMaxHandicapStones(boardSize);
    return Array.from({ length: max + 1 }, (_, index) => index);
  }, [boardSize]);

  // Load history from localStorage
  useEffect(() => {
    Promise.resolve().then(() => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          setSavedGames(JSON.parse(stored));
        }
      } catch (e) {
        console.error('Failed to load saved games:', e);
      }
    });
  }, []);

  // Save game helper
  const saveGameToHistory = useCallback((gameToSave: SavedGame) => {
    setSavedGames(prev => {
      const next = [gameToSave, ...prev];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error('Failed to save game to localStorage:', e);
      }
      return next;
    });
  }, []);

  // Delete game helper
  const deleteGameFromHistory = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSavedGames(prev => {
      const next = prev.filter(g => g.id !== id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error('Failed to delete game from localStorage:', e);
      }
      return next;
    });
  }, []);

  // Auto-save current game on game over
  useEffect(() => {
    if (gameOver && !isReviewMode && !hasSavedCurrentGame && moveRecords.length > 0) {
      const scoreResult = calculateScore(gameState, komi);
      const gameToSave: SavedGame = {
        id: `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        date: new Date().toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
        boardSize: gameState.boardSize,
        gameMode,
        handicap: gameState.handicap,
        komi,
        winner: scoreResult.winner,
        scoreResult,
        moveRecords,
        winRateHistory,
      };
      Promise.resolve().then(() => {
        saveGameToHistory(gameToSave);
        setHasSavedCurrentGame(true);
      });
    }
  }, [gameOver, isReviewMode, hasSavedCurrentGame, gameState, gameMode, komi, moveRecords, winRateHistory, saveGameToHistory]);

  // Analysis effect
  useEffect(() => {
    let active = true;
    const shouldSkip = isReviewMode 
      ? !showAnalysis 
      : (!showAnalysis || gameOver || isAiTurn);

    if (shouldSkip) {
      Promise.resolve().then(() => {
        if (active) setAnalysisResult(null);
      });
      return;
    }

    Promise.resolve().then(() => {
      if (active) {
        setAnalysisLoading(true);
        setNotice('');
      }
    });

    getKataGoAnalysis(currentViewedState, komi, 800)
      .then(result => {
        if (!active) return;
        setAnalysisResult(result);
        setAnalysisLoading(false);

        if (!isReviewMode) {
          const moveNumber = currentViewedState.moveRecords.length;
          if (result.moves && result.moves.length > 0) {
            const bestMove = result.moves[0];
            const bestWinrate = bestMove.winrate;
            const blackWinrate = result.currentPlayer === 'black' ? bestWinrate : (100 - bestWinrate);
            setWinRateHistory(prev => {
              const filtered = prev.filter(p => p.moveNumber < moveNumber);
              return [...filtered, { moveNumber, blackWinrate }];
            });
          }
        }
      })
      .catch(err => {
        if (!active) return;
        console.error('KataGo analysis error:', err);
        setAnalysisResult(null);
        setAnalysisLoading(false);
        setNotice('KataGo Bridge 未启动，请运行 npm run bridge');
      });

    return () => {
      active = false;
    };
  }, [currentViewedState, komi, showAnalysis, gameOver, isAiTurn, isReviewMode]);

  const workerRef = useRef<Worker | null>(null);
  const aiPendingRef = useRef(false);
  const aiRequestIdRef = useRef(0);

  // Derived UI variables based on currentViewedState
  const moveCount = currentViewedState.moveRecords.length;
  const boardDisabled = gameOver || aiThinking || isAiTurn || nigiriPending;

  const score = useMemo(() => calculateScore(currentViewedState, komi), [currentViewedState, komi]);
  const boardFill = useMemo(() => {
    const occupied = currentViewedState.board.reduce(
      (sum, row) => sum + row.filter(Boolean).length,
      0,
    );
    return Math.round((occupied / (currentViewedState.boardSize * currentViewedState.boardSize)) * 100);
  }, [currentViewedState.boardSize, currentViewedState.board]);
  const recentMoves = currentViewedState.moveRecords.slice(-10).reverse();

  // Play stone sound when a move is made or navigated forward
  const lastMoveCountRef = useRef(moveCount);
  useEffect(() => {
    if (moveCount > lastMoveCountRef.current) {
      playStoneSound();
      const lastMove = currentViewedState.moveRecords[moveCount - 1];
      if (lastMove && lastMove.captures > 0) {
        playCaptureSound();
      }
    }
    lastMoveCountRef.current = moveCount;
  }, [moveCount, currentViewedState.moveRecords]);

  // Winrate history selection
  const effectiveWinRateHistory = useMemo(() => {
    if (isReviewMode && reviewGame) {
      return reviewGame.winRateHistory || [];
    }
    return winRateHistory;
  }, [isReviewMode, reviewGame, winRateHistory]);

  const applyAIResult = useCallback((aiResult: AIResult) => {
    if (aiResult === 'resign') {
      setGameState(prev => resign(prev));
    } else if (aiResult) {
      setGameState(prev => placeStone(prev, aiResult));
    } else {
      setGameState(prev => pass(prev));
    }
    setAiThinking(false);
    aiPendingRef.current = false;
  }, []);

  const handleMove = useCallback((pos: Position) => {
    if (isReviewMode) {
      const baseState = trialState || reviewGameState;
      if (!baseState) return;
      if (!isValidMove(baseState, pos)) {
        setNotice('该位置不可落子');
        return;
      }
      setNotice('');
      setTrialState(placeStone(baseState, pos));
      return;
    }

    if (gameMode === 'pve' && currentPlayer !== humanColor) return;
    if (!isValidMove(gameState, pos)) {
      setNotice('该位置不可落子');
      return;
    }
    setNotice('');
    setGameState(prev => placeStone(prev, pos));
  }, [isReviewMode, trialState, reviewGameState, gameMode, currentPlayer, humanColor, gameState]);

  const handlePass = () => {
    if (gameMode === 'pve' && currentPlayer !== humanColor) return;
    setNotice('');
    setGameState(prev => pass(prev));
  };

  const handleResign = () => {
    setNotice('');
    setGameState(prev => resign(prev));
  };

  const handleUndo = () => {
    if (aiThinking || moveRecords.length === 0) return;
    setNotice('');
    aiRequestIdRef.current += 1;
    setGameState(prev => {
      let next = undo(prev);
      if (gameMode === 'pve' && next.currentPlayer !== humanColor && next.moveRecords.length > 0) {
        next = undo(next);
      }
      return next;
    });
  };

  const handleNigiriGuess = (guess: NigiriGuess) => {
    if (nigiri.status !== 'pending') return;
    const correct = (nigiri.hiddenStones % 2 === 1 && guess === 'odd') ||
      (nigiri.hiddenStones % 2 === 0 && guess === 'even');
    const nextHumanColor: Stone = correct ? 'black' : 'white';
    setHumanColor(nextHumanColor);
    setNigiri({
      status: 'revealed',
      hiddenStones: nigiri.hiddenStones,
      guess,
      correct,
      humanColor: nextHumanColor,
    });
    setNotice(correct ? '猜中，你执黑先行' : '未猜中，你执白后行');
  };

  const handleNewGame = (size: number, mode: GameMode, requestedHandicap = handicap) => {
    const nextHandicap = normalizeHandicap(size, requestedHandicap);
    setGameMode(mode);
    setAiThinking(false);
    setNotice(nextHandicap > 0 ? `${handicapLabel(nextHandicap)}，白方先行` : '');
    setHumanColor('black');
    setNigiri(mode === 'pve' && nextHandicap === 0 ? createNigiri() : { status: 'idle' });
    aiRequestIdRef.current += 1;
    aiPendingRef.current = false;
    setWinRateHistory([]);
    setAnalysisResult(null);
    setGameState(createInitialState(size, nextHandicap));
    setIsReviewMode(false);
    setReviewGame(null);
    setReviewStep(0);
    setTrialState(null);
    setHasSavedCurrentGame(false);
  };

  const handleStartReview = (game: SavedGame) => {
    setReviewGame(game);
    setReviewStep(game.moveRecords.length);
    setIsReviewMode(true);
    setTrialState(null);
    setGameState(createInitialState(game.boardSize, game.handicap ?? 0));
  };

  const handleExitReview = () => {
    setIsReviewMode(false);
    setReviewGame(null);
    setReviewStep(0);
    setTrialState(null);
  };

  const goToStart = () => {
    setReviewStep(0);
    setTrialState(null);
    setNotice('');
  };

  const prevStep = () => {
    setReviewStep(prev => Math.max(0, prev - 1));
    setTrialState(null);
    setNotice('');
  };

  const nextStep = () => {
    if (!reviewGame) return;
    setReviewStep(prev => Math.min(reviewGame.moveRecords.length, prev + 1));
    setTrialState(null);
    setNotice('');
  };

  const goToEnd = () => {
    if (!reviewGame) return;
    setReviewStep(reviewGame.moveRecords.length);
    setTrialState(null);
    setNotice('');
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    setReviewStep(val);
    setTrialState(null);
    setNotice('');
  };

  useEffect(() => {
    workerRef.current = new Worker(new URL('../game/aiWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current.onmessage = (e: MessageEvent<AIWorkerResponse>) => {
      if (e.data.id !== aiRequestIdRef.current) return;
      applyAIResult(e.data.result);
    };
    return () => {
      workerRef.current?.terminate();
    };
  }, [applyAIResult]);

  useEffect(() => {
    if (!isAiTurn || aiPendingRef.current) return;
    aiPendingRef.current = true;
    setAiThinking(true);
    setNotice('');
    const requestId = aiRequestIdRef.current + 1;
    aiRequestIdRef.current = requestId;

    if (aiEngine === 'katago') {
      getKataGoMove(gameState, komi, aiDifficulty)
        .then(result => {
          if (requestId !== aiRequestIdRef.current) return;
          applyAIResult(result);
        })
        .catch(() => {
          if (requestId !== aiRequestIdRef.current) return;
          setNotice('KataGo bridge 未连接，已改用本地 AI');
          workerRef.current?.postMessage({ id: requestId, state: gameState, difficulty: aiDifficulty });
        });
      return;
    }

    workerRef.current?.postMessage({ id: requestId, state: gameState, difficulty: aiDifficulty });
  }, [aiDifficulty, aiEngine, applyAIResult, gameState, isAiTurn, komi]);

  const statusText = () => {
    if (isReviewMode) {
      if (trialState) return '研究变化中';
      return `复盘中：第 ${reviewStep} / ${reviewGame?.moveRecords.length || 0} 手`;
    }
    if (nigiriPending) return '猜先决定执黑';
    if (gameOver) {
      if (passCount >= 2) return `终局，${formatWinner(score, gameMode, humanColor)} ${scoreLead(score)} 目`;
      return `${playerLabel(opponentOf(currentPlayer), gameMode, humanColor)}获胜，对方认输`;
    }
    if (aiThinking) return `${aiEngineLabel(aiEngine)} · ${aiDifficultyLabel(aiDifficulty)} 正在计算`;
    return `${playerLabel(currentPlayer, gameMode, humanColor)}落子`;
  };

  const statusTone = isReviewMode
    ? (trialState ? 'status-trial' : 'status-review')
    : (gameOver || nigiriPending ? 'status-ended' : currentPlayer === 'black' ? 'status-black' : 'status-white');
  const playerColorText = gameMode === 'pve' && !nigiriPending ? `你执${colorLabel(humanColor)}` : null;

  const renderWinRateChart = () => {
    if (effectiveWinRateHistory.length < 2) return null;
    
    const width = 300;
    const height = 65;
    const padding = { top: 5, right: 5, bottom: 5, left: 25 };
    
    const maxX = Math.max(...effectiveWinRateHistory.map(p => p.moveNumber));
    const minX = 0;
    
    const getX = (xVal: number) => {
      if (maxX === minX) return padding.left;
      return padding.left + ((xVal - minX) / (maxX - minX)) * (width - padding.left - padding.right);
    };
    
    const getY = (yVal: number) => {
      return padding.top + (1 - yVal / 100) * (height - padding.top - padding.bottom);
    };

    let linePath = '';
    let areaPath = '';
    
    effectiveWinRateHistory.forEach((pt, idx) => {
      const cx = getX(pt.moveNumber);
      const cy = getY(pt.blackWinrate);
      
      if (idx === 0) {
        linePath = `M ${cx} ${cy}`;
        areaPath = `M ${cx} ${getY(50)} L ${cx} ${cy}`;
      } else {
        linePath += ` L ${cx} ${cy}`;
        areaPath += ` L ${cx} ${cy}`;
      }
      
      if (idx === effectiveWinRateHistory.length - 1) {
        areaPath += ` L ${cx} ${getY(50)} Z`;
      }
    });

    const midY = getY(50);

    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="winrateAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(34, 197, 94, 0.4)" />
            <stop offset="100%" stopColor="rgba(56, 189, 248, 0.1)" />
          </linearGradient>
        </defs>
        
        <line x1={padding.left} y1={midY} x2={width - padding.right} y2={midY} stroke="rgba(55, 50, 43, 0.15)" strokeWidth={1} strokeDasharray="3,3" />
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="rgba(55, 50, 43, 0.15)" strokeWidth={1} />
        
        <text x={padding.left - 5} y={padding.top + 4} fill="#8a8377" fontSize={8} textAnchor="end">B 100%</text>
        <text x={padding.left - 5} y={midY + 3} fill="#8a8377" fontSize={8} textAnchor="end">50%</text>
        <text x={padding.left - 5} y={height - padding.bottom} fill="#8a8377" fontSize={8} textAnchor="end">W 100%</text>

        <path d={areaPath} fill="url(#winrateAreaGrad)" />
        <path d={linePath} fill="none" stroke="#22c55e" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />

        {isReviewMode && reviewStep > 0 && reviewStep <= maxX && (
          <line
            x1={getX(reviewStep)}
            y1={padding.top}
            x2={getX(reviewStep)}
            y2={height - padding.bottom}
            stroke="#ea580c"
            strokeWidth={1.5}
            strokeDasharray="2,2"
          />
        )}

        {effectiveWinRateHistory.length > 0 && (
          <circle
            cx={getX(effectiveWinRateHistory[effectiveWinRateHistory.length - 1].moveNumber)}
            cy={getY(effectiveWinRateHistory[effectiveWinRateHistory.length - 1].blackWinrate)}
            r={3.5}
            fill="#22c55e"
            stroke="#ffffff"
            strokeWidth={1.2}
          />
        )}
      </svg>
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="" className="brand-logo" />
          <div>
            <h1>围棋</h1>
            <p>{gameMode === 'pve' ? '人机对弈' : '双人对弈'} · {currentViewedState.boardSize} 路棋盘{playerColorText ? ` · ${playerColorText}` : ''}</p>
          </div>
        </div>

        <div className="quick-stats" aria-label="对局概要">
          <span>第 {moveCount} 手</span>
          <span>占用 {boardFill}%</span>
          <span>贴目 {komi.toFixed(1)}</span>
          <span>{handicapLabel(viewedHandicap)}</span>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className={`bgm-toggle-btn ${bgmPlaying ? 'active' : ''}`}
            onClick={toggleBgm}
          >
            {bgmPlaying ? '🔊 溪流音效' : '🔇 溪流音效'}
          </button>
        </div>
      </header>

      <main className="game-layout">
        <section className="board-section" aria-label="棋盘">
          <Board
            state={currentViewedState}
            onMove={handleMove}
            disabled={isReviewMode ? false : boardDisabled}
            analysis={analysisResult}
            showAnalysis={showAnalysis}
            hoveredAnalysisMove={hoveredAnalysisMove}
          />
        </section>

        <aside className="side-panel">
          <section className="status-block">
            <div className={`turn-chip ${statusTone}`}>
              {!gameOver && !aiThinking && !nigiriPending && <span className={`stone-dot ${currentViewedState.currentPlayer}`} />}
              {aiThinking && <span className="spinner" />}
              <span>{statusText()}</span>
            </div>
            {notice && <div className="notice">{notice}</div>}
          </section>

          {/* Review HUD Navigation Panel */}
          {isReviewMode && (
            <section className="panel-section review-hud-card">
              <div className="section-heading">
                <h2>复盘进度</h2>
                <span>{reviewStep} / {reviewGame?.moveRecords.length || 0}</span>
              </div>
              <div className="review-slider-box">
                <input
                  type="range"
                  min={0}
                  max={reviewGame?.moveRecords.length || 0}
                  value={reviewStep}
                  onChange={handleSliderChange}
                  disabled={!!trialState}
                  className="review-slider"
                />
              </div>
              <div className="review-btn-row">
                <button type="button" onClick={goToStart} disabled={reviewStep === 0 || !!trialState} title="第一手">
                  ⏮️
                </button>
                <button type="button" onClick={prevStep} disabled={reviewStep === 0 || !!trialState} title="上一手">
                  ◀️
                </button>
                <button type="button" onClick={nextStep} disabled={reviewStep === (reviewGame?.moveRecords.length || 0) || !!trialState} title="下一手">
                  ▶️
                </button>
                <button type="button" onClick={goToEnd} disabled={reviewStep === (reviewGame?.moveRecords.length || 0) || !!trialState} title="最后一手">
                  ⏭️
                </button>
              </div>
              {trialState && (
                <div className="trial-badge">
                  💡 处于局部探索状态。点击棋盘放置临时棋子以探索变化，分析结果已切换至该变化。
                </div>
              )}
            </section>
          )}

          {/* Game Over Actions Quick Review */}
          {gameOver && !isReviewMode && (
            <section className="panel-section game-over-card">
              <div className="game-over-title">🎉 对局已结束</div>
              <p className="game-over-desc">
                您可以选择立即进入复盘，查看全局胜率曲线和 KataGo 智能推荐点。
              </p>
              <div className="game-over-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    const scoreResult = calculateScore(gameState, komi);
                    const gameToReview: SavedGame = {
                      id: `game_temp`,
                      date: new Date().toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                      boardSize: gameState.boardSize,
                      gameMode,
                      handicap: gameState.handicap,
                      komi,
                      winner: scoreResult.winner,
                      scoreResult,
                      moveRecords,
                      winRateHistory,
                    };
                    handleStartReview(gameToReview);
                  }}
                >
                  🔍 进入智能复盘
                </button>
              </div>
            </section>
          )}

          {gameMode === 'pve' && !isReviewMode && (
            <section className="panel-section nigiri-card">
              <div className="section-heading">
                <h2>猜先</h2>
                {nigiri.status === 'revealed' && <span>{nigiri.correct ? '猜中' : '未中'}</span>}
              </div>
              {nigiri.status === 'pending' && (
                <>
                  <div className="nigiri-stones" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="nigiri-actions">
                    <button type="button" onClick={() => handleNigiriGuess('odd')}>单数</button>
                    <button type="button" onClick={() => handleNigiriGuess('even')}>双数</button>
                  </div>
                </>
              )}
              {nigiri.status === 'revealed' && (
                <div className="nigiri-result">
                  <span>AI 取子 {nigiri.hiddenStones}</span>
                  <span>你猜 {guessLabel(nigiri.guess)}</span>
                  <strong>你执{colorLabel(nigiri.humanColor)}</strong>
                </div>
              )}
            </section>
          )}

          <section className="panel-section captures-grid" aria-label="提子数">
            <div>
              <span className="section-label">{playerLabel('black', gameMode, humanColor)}</span>
              <strong>{currentViewedState.captures.black}</strong>
              <small>黑方提子</small>
            </div>
            <div>
              <span className="section-label">{playerLabel('white', gameMode, humanColor)}</span>
              <strong>{currentViewedState.captures.white}</strong>
              <small>白方提子</small>
            </div>
          </section>

          {isReviewMode ? (
            trialState ? (
              <section className="panel-section action-row" aria-label="研究操作">
                <button type="button" onClick={() => setTrialState(prev => {
                  if (!prev) return null;
                  const next = undo(prev);
                  if (next.moveRecords.length === reviewGameState?.moveRecords.length) {
                    return null;
                  }
                  return next;
                })}>
                  撤销探索
                </button>
                <button type="button" className="primary-button" onClick={() => setTrialState(null)}>
                  返回对局线
                </button>
              </section>
            ) : (
              <section className="panel-section action-row" aria-label="复盘操作">
                <button type="button" className="danger-button" onClick={handleExitReview}>
                  退出复盘
                </button>
              </section>
            )
          ) : (
            <section className="panel-section action-row" aria-label="对局操作">
              <button type="button" onClick={handleUndo} disabled={aiThinking || moveRecords.length === 0}>
                悔棋
              </button>
              <button type="button" onClick={handlePass} disabled={boardDisabled}>
                虚手
              </button>
              <button type="button" className="danger-button" onClick={handleResign} disabled={gameOver || nigiriPending}>
                认输
              </button>
            </section>
          )}

          <section className="panel-section ai-analysis-card">
            <div className="section-heading">
              <h2>AI 智能复盘</h2>
              <button
                type="button"
                className={`analysis-toggle-btn ${showAnalysis ? 'active' : ''}`}
                onClick={() => {
                  setShowAnalysis(!showAnalysis);
                  setHoveredAnalysisMove(null);
                }}
              >
                {showAnalysis ? '已开启' : '已关闭'}
              </button>
            </div>
            
            {showAnalysis && (
              <div className="analysis-box">
                {analysisLoading && (
                  <div className="analysis-spinner-box">
                    <span className="spinner" />
                    <span>KataGo 深度分析中...</span>
                  </div>
                )}
                
                {!analysisLoading && !analysisResult && (
                  <div className="analysis-status-msg">
                    <span>暂无分析数据，请确保 KataGo Bridge 已运行</span>
                  </div>
                )}

                {!analysisLoading && analysisResult && analysisResult.moves && (
                  <div className="analysis-details">
                    {winRateHistory.length > 1 && (
                      <div className="winrate-history-chart">
                        <div className="chart-heading">胜率曲线</div>
                        <div className="chart-svg-container">
                          {renderWinRateChart()}
                        </div>
                      </div>
                    )}

                    <div className="ai-candidates">
                      <div className="candidates-heading">推荐候选落子点</div>
                      <ol className="candidates-list">
                        {analysisResult.moves.slice(0, 4).map((move, idx) => (
                          <li
                            key={idx}
                            className={`candidate-list-item rank-${idx + 1}`}
                            onMouseEnter={() => setHoveredAnalysisMove(move)}
                            onMouseLeave={() => setHoveredAnalysisMove(null)}
                          >
                            <span className="rank-num">#{idx + 1}</span>
                            <span className="coord-text">{move.gtpMove}</span>
                            <div className="candidate-stats">
                              <span className="rate-text">{Math.round(move.winrate)}% 胜率</span>
                              <span className="lead-text">
                                {move.scoreLead > 0 ? `+${move.scoreLead.toFixed(1)}` : move.scoreLead.toFixed(1)} 目
                              </span>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <div className="analysis-card-footer">💡 悬停在候选点上可在棋盘预览后续变化图 (PV)</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <h2>形势</h2>
              <label className="komi-control">
                贴目
                <input
                  type="number"
                  min="0"
                  max="20"
                  step="0.5"
                  value={komi}
                  onChange={event => setKomi(Number(event.target.value) || 0)}
                />
              </label>
            </div>
            <div className="score-summary">
              <div>
                <span>黑</span>
                <strong>{score.blackTotal.toFixed(1)}</strong>
                <small>子 {score.blackStones} · 空 {score.blackTerritory}</small>
              </div>
              <div>
                <span>白</span>
                <strong>{score.whiteTotal.toFixed(1)}</strong>
                <small>子 {score.whiteStones} · 空 {score.whiteTerritory}</small>
              </div>
            </div>
            <p className="score-lead">
              {formatWinner(score, gameMode, humanColor)} {scoreLead(score)} 目
            </p>
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <h2>新对局</h2>
            </div>
            <div className="segmented-control" role="group" aria-label="对局模式">
              <button
                type="button"
                className={gameMode === 'pvp' ? 'active' : ''}
                onClick={() => handleNewGame(boardSize, 'pvp')}
              >
                双人
              </button>
              <button
                type="button"
                className={gameMode === 'pve' ? 'active' : ''}
                onClick={() => handleNewGame(boardSize, 'pve')}
              >
                人机
              </button>
            </div>
            <div className="segmented-control size-control" role="group" aria-label="棋盘尺寸">
              {BOARD_SIZES.map(size => (
                <button
                  key={size}
                  type="button"
                  className={boardSize === size ? 'active' : ''}
                  onClick={() => handleNewGame(size, gameMode)}
                >
                  {size}路
                </button>
              ))}
            </div>
            <div className="option-label">让子</div>
            <div className="segmented-control handicap-control" role="group" aria-label="让子数">
              {handicapOptions.map(count => (
                <button
                  key={count}
                  type="button"
                  className={handicap === count ? 'active' : ''}
                  onClick={() => handleNewGame(boardSize, gameMode, count)}
                >
                  {count === 0 ? '互先' : `${count}子`}
                </button>
              ))}
            </div>
          </section>

          {gameMode === 'pve' && (
            <section className="panel-section">
              <div className="section-heading">
                <h2>AI 引擎</h2>
              </div>
              <div className="segmented-control" role="group" aria-label="AI 引擎">
                <button
                  type="button"
                  className={aiEngine === 'katago' ? 'active' : ''}
                  onClick={() => setAiEngine('katago')}
                  disabled={aiThinking || katagoSetupLoading}
                >
                  KataGo
                </button>
                <button
                  type="button"
                  className={aiEngine === 'browser' ? 'active' : ''}
                  onClick={() => setAiEngine('browser')}
                  disabled={aiThinking || katagoSetupLoading}
                >
                  本地
                </button>
              </div>
              <div className="option-label">难度</div>
              <div className="segmented-control difficulty-control" role="group" aria-label="AI 难度">
                {AI_DIFFICULTIES.map(item => (
                  <button
                    key={item.value}
                    type="button"
                    className={aiDifficulty === item.value ? 'active' : ''}
                    onClick={() => setAiDifficulty(item.value)}
                    disabled={aiThinking || katagoSetupLoading}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className={`katago-setup ${katagoStatus?.ok ? 'ready' : 'missing'}`}>
                <div>
                  <strong>{katagoStatus?.ok ? 'KataGo 已就绪' : '需要安装 KataGo'}</strong>
                  <span>
                    {katagoStatus?.ok
                      ? katagoStatus.katagoModel ?? '模型已配置'
                      : '一键下载 AI 引擎、模型和配置文件'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={katagoStatus?.ok ? refreshKataGoStatus : handleInstallKataGo}
                  disabled={katagoSetupLoading || aiThinking}
                >
                  {katagoSetupLoading ? '安装中...' : katagoStatus?.ok ? '检测' : '安装 AI 引擎'}
                </button>
              </div>
            </section>
          )}

          <section className="panel-section move-list-section">
            <div className="section-heading">
              <h2>手顺</h2>
              <span>{moveCount ? `最近 ${recentMoves.length} 手` : '暂无'}</span>
            </div>
            <ol className="move-list">
              {recentMoves.map(record => (
                <li key={record.moveNumber}>
                  <span>{record.moveNumber}</span>
                  <b>{playerLabel(record.player, gameMode, humanColor)}</b>
                  <em>{formatMove(record, boardSize)}</em>
                  {record.captures > 0 && <small>提 {record.captures}</small>}
                </li>
              ))}
            </ol>
          </section>

          <section className="panel-section history-panel-card">
            <div className="section-heading">
              <h2>对局历史</h2>
              <span className="history-count">共 {savedGames.length} 局</span>
            </div>
            {savedGames.length === 0 ? (
              <div className="history-empty">暂无历史对局数据</div>
            ) : (
              <div className="history-list">
                {savedGames.map(game => (
                  <div
                    key={game.id}
                    className="history-item"
                    onClick={() => handleStartReview(game)}
                    title="点击进行复盘"
                  >
                    <div className="history-item-header">
                      <span className="game-date">{game.date}</span>
                      <span className="game-badge">
                        {game.boardSize}路 · {game.gameMode === 'pve' ? '人机' : '双人'}{game.handicap ? ` · ${handicapLabel(game.handicap)}` : ''}
                      </span>
                    </div>
                    <div className="history-item-body">
                      <span className="game-result">
                        {game.winner === 'tie' ? '平局' : `${game.winner === 'black' ? '黑' : '白'}胜 (${Math.abs(game.scoreResult.blackTotal - game.scoreResult.whiteTotal).toFixed(1)}目)`}
                      </span>
                      <button
                        type="button"
                        className="delete-history-btn"
                        onClick={(e) => deleteGameFromHistory(game.id, e)}
                        title="删除此记录"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}
