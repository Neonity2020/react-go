// KataGo TF.js Worker — runs neural network inference off the main thread
import * as tf from "@tensorflow/tfjs";

// These imports are bundled into the worker by Vite
import { decompressGzip, parseKataGoModelV8 } from "./loadModel";
import { KataGoModelV8Tf } from "./modelV8";
import {
  buildInputFeatures,
  extractPolicy9x9,
  BOARD_9,
  BOARD_19,
  INPUT_SPATIAL_CHANNELS_V7,
  INPUT_GLOBAL_CHANNELS_V7,
} from "./features";
import type { WorkerRequest, WorkerResponse } from "./types";

let model: KataGoModelV8Tf | null = null;
let activeBackend = "none";

async function initBackend(): Promise<string> {
  // Try WebGPU first
  try {
    await tf.setBackend("webgpu");
    await tf.ready();
    activeBackend = "webgpu";
    return activeBackend;
  } catch {
    // fallthrough
  }

  // Try WASM
  try {
    const { setWasmPaths } = await import("@tensorflow/tfjs-backend-wasm");
    setWasmPaths("/tfjs/");
    await tf.setBackend("wasm");
    await tf.ready();
    activeBackend = "wasm";
    return activeBackend;
  } catch {
    // fallthrough
  }

  // CPU fallback
  await tf.setBackend("cpu");
  await tf.ready();
  activeBackend = "cpu";
  return activeBackend;
}

async function handleInit(modelUrl: string): Promise<WorkerResponse> {
  const errMsg = (label: string, err: unknown): string => {
    const detail = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    return `${label}: ${detail}`;
  };

  try {
    // Step 1: Initialize TF.js backend
    let backend: string;
    try {
      backend = await initBackend();
    } catch (err) {
      return { type: "init_result", ok: false, backend: "none", modelName: "", blocks: 0, channels: 0, error: errMsg("Backend init failed", err) };
    }
    tf.enableProdMode();

    // Step 2: Fetch model
    let response: Response;
    try {
      response = await fetch(modelUrl, { cache: "force-cache" });
    } catch (err) {
      return { type: "init_result", ok: false, backend, modelName: "", blocks: 0, channels: 0, error: errMsg("Model fetch error", err) };
    }
    if (!response.ok) {
      return { type: "init_result", ok: false, backend, modelName: "", blocks: 0, channels: 0, error: `Model fetch failed (${response.status})` };
    }

    // Step 3: Decompress and parse
    let compressed: ArrayBuffer;
    try {
      compressed = await response.arrayBuffer();
    } catch (err) {
      return { type: "init_result", ok: false, backend, modelName: "", blocks: 0, channels: 0, error: errMsg("Model read error", err) };
    }

    let decompressed: Uint8Array;
    try {
      decompressed = decompressGzip(compressed);
    } catch (err) {
      return { type: "init_result", ok: false, backend, modelName: "", blocks: 0, channels: 0, error: errMsg("Gzip decompress failed", err) };
    }

    let parsed: ReturnType<typeof parseKataGoModelV8>;
    try {
      parsed = parseKataGoModelV8(decompressed);
    } catch (err) {
      return { type: "init_result", ok: false, backend, modelName: "", blocks: 0, channels: 0, error: errMsg("Model parse failed", err) };
    }

    // Step 4: Build TF.js model
    try {
      model = new KataGoModelV8Tf(parsed);
    } catch (err) {
      return { type: "init_result", ok: false, backend, modelName: "", blocks: 0, channels: 0, error: errMsg("TF.js model build failed", err) };
    }
    // Step 5: Warmup forward pass
    try {
      const dummySpatial = tf.zeros([1, BOARD_19, BOARD_19, INPUT_SPATIAL_CHANNELS_V7]);
      const dummyGlobal = tf.zeros([1, INPUT_GLOBAL_CHANNELS_V7]);
      const warmup = model.forwardPolicyValue(dummySpatial, dummyGlobal);
      tf.dispose(warmup);
      dummySpatial.dispose();
      dummyGlobal.dispose();
    } catch (err) {
      // Warmup failure is non-fatal, model might still work for real inputs
      console.warn("Warmup failed:", err);
    }

    return {
      type: "init_result",
      ok: true,
      backend,
      modelName: parsed.modelName,
      blocks: parsed.trunk.numBlocks,
      channels: parsed.trunk.trunkNumChannels,
    };
  } catch (err) {
    return {
      type: "init_result",
      ok: false,
      backend: activeBackend,
      modelName: "",
      blocks: 0,
      channels: 0,
      error: errMsg("Init failed", err),
    };
  }
}

async function handleAnalyze(
  board: Int8Array,
  color: number,
  legalIndices: number[],
  moveCount: number,
  moveHistory: Array<{ index: number; color: number }>
): Promise<WorkerResponse> {
  if (!model) {
    return { type: "analyze_result", scores: new Float32Array(82), winrate: 50, error: "Model not loaded" };
  }

  try {
    // Build 19×19 padded features from 9×9 board
    const { spatial, global } = buildInputFeatures(board, color, moveHistory);

    const spatialTensor = tf.tensor4d(spatial, [1, BOARD_19, BOARD_19, INPUT_SPATIAL_CHANNELS_V7]);
    const globalTensor = tf.tensor2d(global, [1, INPUT_GLOBAL_CHANNELS_V7]);

    const result = model.forwardPolicyValue(spatialTensor, globalTensor);

    // Policy output is [1, 19, 19, policyOutChannels] — extract center 9×9
    const policyData = await result.policy.data<Float32Array>();

    // Extract 9×9 scores from 19×19 policy (centered at offset 5)
    const scores = extractPolicy9x9(policyData);

    // Mask illegal moves
    const legalSet = new Set(legalIndices);
    for (let i = 0; i < BOARD_9 * BOARD_9; i++) {
      if (!legalSet.has(i)) {
        scores[i] = -1000;
      }
    }

    // Extract value (winrate)
    const valueData = await result.value.data();
    let winrate: number;
    if (valueData.length >= 3) {
      const wr = 1.0 / (1.0 + Math.exp(-valueData[0]));
      winrate = color === 1 ? wr * 100 : (1 - wr) * 100;
    } else {
      winrate = 1.0 / (1.0 + Math.exp(-valueData[0])) * 100;
    }
    winrate = Math.max(5, Math.min(95, winrate));

    tf.dispose(result);
    spatialTensor.dispose();
    globalTensor.dispose();

    // Return scores (81 board positions) + winrate
    return { type: "analyze_result", scores, winrate };
  } catch (err) {
    return {
      type: "analyze_result",
      scores: new Float32Array(81),
      winrate: 50,
      error: err instanceof Error ? err.message : "Analysis failed",
    };
  }
}

function handleDispose(): void {
  if (model) {
    model.dispose();
    model = null;
  }
}

// Message handler
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    const result = await handleInit(msg.modelUrl);
    (self as unknown as Worker).postMessage(result);
  } else if (msg.type === "analyze") {
    const result = await handleAnalyze(
      msg.board,
      msg.color,
      msg.legalIndices,
      msg.moveCount,
      msg.moveHistory || []
    );
    // Transfer the Float32Array buffer for zero-copy
    (self as unknown as Worker).postMessage(result, [result.scores.buffer]);
  } else if (msg.type === "dispose") {
    handleDispose();
  }
};
