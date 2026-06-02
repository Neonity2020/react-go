// Shared types for the KataGo TF.js engine

export type Player = "black" | "white";

export type AnalyzeRequest = {
  board: Int8Array; // 0=empty, 1=black, 2=white
  color: number; // 1=black, 2=white
  legalIndices: number[];
  moveCount: number;
  moveHistory: Array<{ index: number; color: number }>;
};

export type RuntimeModel = {
  name: string;
  version: string;
  board: number;
  blocks: number;
  channels: number;
  bias: number[];
  layers: Map<string, unknown>;
  neuralReady: boolean;
  loadError?: string;
};

export type KatagoWebGpuRuntime = {
  init: () => Promise<void>;
  loadModel: (url: string) => Promise<RuntimeModel | null>;
  analyze: (request: AnalyzeRequest) => Promise<Float32Array>;
  engineLabel: () => string;
  hasWebGpu: () => boolean;
  model: () => RuntimeModel | null;
};

// Worker message types
export type WorkerInitRequest = {
  type: "init";
  modelUrl: string;
};

export type WorkerAnalyzeRequest = {
  type: "analyze";
  board: Int8Array;
  color: number;
  legalIndices: number[];
  moveCount: number;
  moveHistory: Array<{ index: number; color: number }>;
};

export type WorkerDisposeRequest = {
  type: "dispose";
};

export type WorkerRequest = WorkerInitRequest | WorkerAnalyzeRequest | WorkerDisposeRequest;

export type WorkerInitResponse = {
  type: "init_result";
  ok: boolean;
  backend: string;
  modelName: string;
  blocks: number;
  channels: number;
  error?: string;
};

export type WorkerAnalyzeResponse = {
  type: "analyze_result";
  scores: Float32Array;
  winrate: number;
  error?: string;
};

export type WorkerResponse = WorkerInitResponse | WorkerAnalyzeResponse;
