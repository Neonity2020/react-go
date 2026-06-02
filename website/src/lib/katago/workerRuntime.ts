// Main-thread wrapper for the KataGo TF.js worker
// Maintains the KatagoWebGpuRuntime interface for drop-in replacement

import type {
  KatagoWebGpuRuntime,
  RuntimeModel,
  AnalyzeRequest,
  AnalyzeResult,
  WorkerRequest,
  WorkerResponse,
} from "./types";

export function createKatagoWebGpuRuntime(): KatagoWebGpuRuntime {
  let worker: Worker | null = null;
  let modelInfo: RuntimeModel | null = null;
  let currentBackend = "none";
  let modelLoadError = "";
  let msgId = 0;
  const pending = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (err: Error) => void }>();

  function getWorker(): Worker {
    if (!worker) {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse & { _msgId?: number }>) => {
        const data = event.data;
        // The worker doesn't use msgId in responses, so we resolve the most recent pending
        const firstKey = pending.keys().next().value;
        if (firstKey !== undefined) {
          const { resolve } = pending.get(firstKey)!;
          pending.delete(firstKey);
          resolve(data);
        }
      };
      worker.onerror = (err) => {
        const firstKey = pending.keys().next().value;
        if (firstKey !== undefined) {
          const { reject } = pending.get(firstKey)!;
          pending.delete(firstKey);
          reject(new Error(err.message));
        }
      };
    }
    return worker;
  }

  function postToWorker(msg: WorkerRequest): Promise<WorkerResponse> {
    const id = ++msgId;
    return new Promise<WorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage(msg);
    });
  }

  async function init(): Promise<void> {
    // Worker is created lazily in loadModel
  }

  async function loadModel(url: string): Promise<RuntimeModel | null> {
    try {
      const result = await postToWorker({ type: "init", modelUrl: url });

      if (result.type === "init_result") {
        if (!result.ok) {
          modelLoadError = result.error || "Model load failed";
          modelInfo = null;
          return null;
        }
        currentBackend = result.backend;
        modelLoadError = "";
        modelInfo = {
          name: result.modelName,
          version: "TF.js",
          board: 9,
          blocks: result.blocks,
          channels: result.channels,
          bias: [],
          layers: new Map(),
          neuralReady: true,
        };
        return modelInfo;
      }
      return null;
    } catch (err) {
      modelLoadError = err instanceof Error ? err.message : "Model load failed";
      modelInfo = null;
      return null;
    }
  }

  async function analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const result = await postToWorker({
      type: "analyze",
      board: request.board,
      color: request.color,
      legalIndices: request.legalIndices,
      moveCount: request.moveCount,
      moveHistory: request.moveHistory || [],
    });

    if (result.type === "analyze_result") {
      if (result.error) {
        console.warn("KataGo analyze error:", result.error);
        return { scores: result.scores, winrate: result.winrate, error: result.error };
      }
      return { scores: result.scores, winrate: result.winrate };
    }
    return { scores: new Float32Array(81), winrate: 50, error: "Unexpected worker response" };
  }

  function engineLabel(): string {
    if (modelInfo) {
      return `KataGo TF.js (${currentBackend}) · ${modelInfo.name}`;
    }
    if (modelLoadError) {
      return `TF.js engine · ${modelLoadError}`;
    }
    return "TF.js engine · browser AI";
  }

  function hasWebGpu(): boolean {
    return currentBackend === "webgpu";
  }

  return {
    init,
    loadModel,
    analyze,
    engineLabel,
    hasWebGpu,
    model: () => modelInfo,
  };
}
