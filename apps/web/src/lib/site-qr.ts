/**
 * A small QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1 to
 * 10 (up to 213 bytes, far more than a membership code needs). Pure: text in, a square matrix
 * of dark/light modules out. It exists so a guest's membership code can be drawn as an inline
 * SVG without sending the code to anyone else's service.
 */

const EC_BITS_M = 0; // format bits for level M
/** Per version: [ec codewords per block, [blocks, data codewords per block][]] at level M. */
const BLOCKS_M: Array<[number, Array<[number, number]>]> = [
  [0, []],
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGNMENT: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const dataCapacity = (v: number) => BLOCKS_M[v]![1].reduce((s, [n, d]) => s + n * d, 0);

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((d, i) => (result[i]! ^= gfMul(d, factor)));
  }
  return result;
}

function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacityBits = dataCapacity(version) * 8;
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCapacity(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function withErrorCorrection(data: number[], version: number): number[] {
  const [ecLen, groups] = BLOCKS_M[version]!;
  const divisor = rsDivisor(ecLen);
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let k = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ data: d, ec: rsRemainder(d, divisor) });
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFn(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, version: number) {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.setFn(6, i, i % 2 === 0);
    m.setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        m.setFn(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = ALIGNMENT[version]!;
  const last = pos.length - 1;
  pos.forEach((cy, i) =>
    pos.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(m, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFn(a, b, dark);
      m.setFn(b, a, dark);
    }
  }
}

function drawFormat(m: Matrix, mask: number) {
  const data = (EC_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(i));
  m.setFn(8, 7, bit(6));
  m.setFn(8, 8, bit(7));
  m.setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.setFn(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFn(8, size - 15 + i, bit(i));
  m.setFn(8, size - 8, true);
}

function placeCodewords(m: Matrix, codewords: number[]) {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.fn[y]![x] && i < codewords.length * 8) {
          m.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function applyMask(m: Matrix, mask: number) {
  const f = MASKS[mask]!;
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (!m.fn[y]![x] && f(x, y)) m.modules[y]![x] = !m.modules[y]![x];
}

/** The standard's penalty score: lower is easier for a camera to read. */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0;
  const lines = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      for (let b = 0; b + 6 < size; b++) {
        const w = (k: number) => (b + k < size ? get(a, b + k) : false);
        const core = w(0) && !w(1) && w(2) && w(3) && w(4) && !w(5) && w(6);
        if (!core) continue;
        const before = [1, 2, 3, 4].every((k) => b - k < 0 || !get(a, b - k));
        const after = [7, 8, 9, 10].every((k) => b + k >= size || !get(a, b + k));
        if (before || after) score += 40;
      }
    }
  };
  lines((y, x) => grid[y]![x]!);
  lines((x, y) => grid[y]![x]!);
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = grid[y]![x];
      if (c === grid[y]![x + 1] && c === grid[y + 1]![x] && c === grid[y + 1]![x + 1]) score += 3;
    }
  }
  const dark = grid.reduce((s, row) => s + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

/** Encode text as a QR code. Throws when the text is too long for version 10 at level M. */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++;
  if (version > 10) throw new Error('Text too long for a QR code here.');
  const codewords = withErrorCorrection(encodeData(bytes, version), version);
  const size = version * 4 + 17;

  let best: { mask: number; score: number; modules: boolean[][] } | null = null;
  for (const mask of opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask]) {
    const m = new Matrix(size);
    drawFunctionPatterns(m, version);
    placeCodewords(m, codewords);
    applyMask(m, mask);
    drawFormat(m, mask);
    const score = penalty(m.modules);
    if (!best || score < best.score) best = { mask, score, modules: m.modules };
  }
  return { size, version, mask: best!.mask, modules: best!.modules };
}

/** The dark modules as one SVG path ("M x y h1 v1 h-1 z" per module), for a single <path>. */
export function qrPath(qr: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => row.forEach((dark, x) => dark && parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)));
  return parts.join('');
}
