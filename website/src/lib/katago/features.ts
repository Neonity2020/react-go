// Input feature plane construction for KataGo V7
// 9×9 board padded to 19×19 (the b6c96 model was trained on 19×19)

const BOARD_9 = 9;
const BOARD_19 = 19;
const PAD = 5; // (19 - 9) / 2 = 5
const INPUT_SPATIAL_CHANNELS_V7 = 22;
const INPUT_GLOBAL_CHANNELS_V7 = 19;

function idxNHWC19(x: number, y: number, c: number): number {
  return (y * BOARD_19 + x) * INPUT_SPATIAL_CHANNELS_V7 + c;
}

function computeLiberties9(stones: Int8Array, pos: number): number {
  const color = stones[pos];
  if (color === 0) return 0;
  const visited = new Set<number>();
  const queue = [pos];
  let liberties = 0;
  visited.add(pos);
  while (queue.length > 0) {
    const current = queue.pop()!;
    const cx = current % BOARD_9;
    const cy = (current / BOARD_9) | 0;
    const neighbors: number[] = [];
    if (cx > 0) neighbors.push(current - 1);
    if (cx < BOARD_9 - 1) neighbors.push(current + 1);
    if (cy > 0) neighbors.push(current - BOARD_9);
    if (cy < BOARD_9 - 1) neighbors.push(current + BOARD_9);
    for (const n of neighbors) {
      if (visited.has(n)) continue;
      visited.add(n);
      if (stones[n] === 0) {
        liberties++;
      } else if (stones[n] === color) {
        queue.push(n);
      }
    }
  }
  return liberties;
}

export function buildInputFeatures(
  board: Int8Array, // 0=empty, 1=black, 2=white (9×9 = 81 elements)
  color: number, // 1=black, 2=white (current player)
  moveHistory: Array<{ index: number; color: number }>
): { spatial: Float32Array; global: Float32Array } {
  // Build 19×19 spatial feature tensor, with 9×9 board centered at offset PAD
  const spatial = new Float32Array(BOARD_19 * BOARD_19 * INPUT_SPATIAL_CHANNELS_V7);
  const global = new Float32Array(INPUT_GLOBAL_CHANNELS_V7);

  const plaColor = color;
  const oppColor = color === 1 ? 2 : 1;

  // Channel 0: all ones for the 9×9 valid region
  for (let y = 0; y < BOARD_9; y++) {
    for (let x = 0; x < BOARD_9; x++) {
      spatial[idxNHWC19(x + PAD, y + PAD, 0)] = 1.0;
    }
  }

  // Channels 1-2: current player stones, opponent stones
  // Channels 3-5: liberties (1, 2, 3+)
  for (let y = 0; y < BOARD_9; y++) {
    for (let x = 0; x < BOARD_9; x++) {
      const pos = y * BOARD_9 + x;
      const v = board[pos];
      if (v === 0) continue;
      const tx = x + PAD;
      const ty = y + PAD;
      if (v === plaColor) spatial[idxNHWC19(tx, ty, 1)] = 1.0;
      else if (v === oppColor) spatial[idxNHWC19(tx, ty, 2)] = 1.0;

      const libs = computeLiberties9(board, pos);
      if (libs === 1) spatial[idxNHWC19(tx, ty, 3)] = 1.0;
      else if (libs === 2) spatial[idxNHWC19(tx, ty, 4)] = 1.0;
      else if (libs >= 3) spatial[idxNHWC19(tx, ty, 5)] = 1.0;
    }
  }

  // Channel 6: ko point (not tracked, leave zero)

  // Channels 9-13: recent move markers (last 5 moves)
  const historyPlanes = [9, 10, 11, 12, 13];
  const expectedColors = [oppColor, plaColor, oppColor, plaColor, oppColor];
  const recentMoves = moveHistory.slice(-5);
  for (let i = 0; i < Math.min(recentMoves.length, 5); i++) {
    const move = recentMoves[recentMoves.length - 1 - i];
    if (move.color !== expectedColors[i]) break;
    const x = (move.index % BOARD_9) + PAD;
    const y = ((move.index / BOARD_9) | 0) + PAD;
    spatial[idxNHWC19(x, y, historyPlanes[i])] = 1.0;
  }

  // Global channel 5: self-komi / 20
  const komi = 5.5; // standard 9×9 komi
  const selfKomi = plaColor === 2 ? komi : -komi;
  global[5] = selfKomi / 20.0;

  return { spatial, global };
}

/**
 * Extract 9×9 policy scores from the 19×19 policy output.
 * The 9×9 board is centered in the 19×19 at offset PAD.
 */
export function extractPolicy9x9(policyData: Float32Array | Float32Array[]): Float32Array {
  const scores = new Float32Array(BOARD_9 * BOARD_9);
  // policy shape is [1, 19, 19, 1] → flat NHWC data
  const data = Array.isArray(policyData) ? policyData[0] : policyData;
  for (let y = 0; y < BOARD_9; y++) {
    for (let x = 0; x < BOARD_9; x++) {
      scores[y * BOARD_9 + x] = data[(y + PAD) * BOARD_19 + (x + PAD)];
    }
  }
  return scores;
}

export { BOARD_9, BOARD_19, PAD, INPUT_SPATIAL_CHANNELS_V7, INPUT_GLOBAL_CHANNELS_V7 };
