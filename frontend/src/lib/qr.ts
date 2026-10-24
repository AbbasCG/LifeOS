/**
 * Minimal QR Code (model 2) encoder: byte mode, versions 1–40, error-correction levels L/M/Q/H,
 * Reed–Solomon over GF(256), automatic mask selection by the standard penalty rules.
 * Used to show the two-factor setup secret without adding a dependency.
 */
export type Ecc = 'L' | 'M' | 'Q' | 'H'

const ECC_ORDINAL: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 }
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 }
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

function rawDataModules(ver: number) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function dataCodewords(ver: number, ecc: Ecc) {
  const e = ECC_ORDINAL[ecc]
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver]
}

function gfMultiply(x: number, y: number) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number) {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]) {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor) })
  }
  return result
}

function alignmentPositions(ver: number) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

/** Encode text (UTF-8) into a square matrix of dark (true) / light (false) modules. */
export function encodeQr(text: string, ecc: Ecc = 'M'): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let ver = 1
  for (; ; ver++) {
    if (ver > 40) throw new Error('Data too long for a QR code')
    const countBits = ver <= 9 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver, ecc) * 8) break
  }
  const capacity = dataCodewords(ver, ecc) * 8
  const bits: number[] = []
  const append = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  append(0x4, 4)
  append(bytes.length, ver <= 9 ? 8 : 16)
  bytes.forEach(b => append(b, 8))
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))

  // Error correction and interleaving.
  const e = ECC_ORDINAL[ecc]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver], blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver]
  const rawCodewords = Math.floor(rawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const eccBytes = rsRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(eccBytes))
  }
  const codewords: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => { if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]) })
  }

  // Function patterns.
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const setFunction = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; isFunction[y][x] = true }
  for (let i = 0; i < size; i++) { setFunction(6, i, i % 2 === 0); setFunction(i, 6, i % 2 === 0) }
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunction(xx, yy, dist !== 2 && dist !== 4)
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  const align = alignmentPositions(ver)
  align.forEach((a, i) => align.forEach((b, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFunction(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const drawFormat = (mask: number) => {
    const data5 = (ECC_FORMAT_BITS[ecc] << 3) | mask
    let rem = data5
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const fmt = ((data5 << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(fmt, i))
    setFunction(8, 7, bit(fmt, 6)); setFunction(8, 8, bit(fmt, 7)); setFunction(7, 8, bit(fmt, 8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(fmt, i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(fmt, i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(fmt, i))
    setFunction(8, size - 8, true)
  }
  drawFormat(0)
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const v = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = bit(v, i), a = size - 11 + (i % 3), b = Math.floor(i / 3)
      setFunction(a, b, dark); setFunction(b, a, dark)
    }
  }

  // Data placement in the zigzag order.
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert
      if (!isFunction[y][x] && index < codewords.length * 8) { modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7)); index++ }
    }
  }

  const maskFn = [
    (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ]
  const applyMask = (mask: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && maskFn[mask](x, y)) modules[y][x] = !modules[y][x] }
  let best = 0, bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask); drawFormat(mask)
    const p = penalty(modules)
    if (p < bestPenalty) { bestPenalty = p; best = mask }
    applyMask(mask)
  }
  applyMask(best); drawFormat(best)
  return modules
}

/** Standard penalty rules N1–N4 (adjacent runs, 2×2 blocks, finder-like patterns, dark balance). */
function penalty(m: boolean[][]) {
  const size = m.length
  let score = 0
  const lines = [...m, ...m[0].map((_, x) => m.map(row => row[x]))]
  const finderA = [true, false, true, true, true, false, true, false, false, false, false], finderB = [...finderA].reverse()
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++
      else { if (run >= 5) score += 3 + (run - 5); run = 1 }
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (finderA.every((v, k) => line[i + k] === v) || finderB.every((v, k) => line[i + k] === v)) score += 40
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x]
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3
  }
  const dark = m.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return score
}
