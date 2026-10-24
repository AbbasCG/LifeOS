/**
 * Pure geometry and matrix helpers for the LifeOS orb (no WebGL here, so they are unit-testable).
 * Matrices are column-major Float32Array(16), matching WebGL's uniformMatrix4fv.
 */
export type Mesh = { positions: Float32Array; indices: Uint16Array }

/** Unit icosphere: 12 vertices refined `detail` times (10·4ⁿ + 2 vertices, 20·4ⁿ triangles). */
export function icosphere(detail: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2
  const verts: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(normalize)
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let level = 0; level < detail; level++) {
    const cache = new Map<string, number>()
    const midpoint = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      const [x1, y1, z1] = verts[a], [x2, y2, z2] = verts[b]
      verts.push(normalize([(x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2]))
      cache.set(key, verts.length - 1)
      return verts.length - 1
    }
    faces = faces.flatMap(([a, b, c]) => { const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]] })
  }
  return { positions: new Float32Array(verts.flat()), indices: new Uint16Array(faces.flat()) }
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far)
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0])
}

export function translation(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
}

/** Rotation about X (pitch) then Y (yaw), uniformly scaled. */
export function rotation(pitch: number, yaw: number, scale = 1): Float32Array {
  const cx = Math.cos(pitch), sx = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw)
  return new Float32Array([cy * scale, sx * sy * scale, -cx * sy * scale, 0, 0, cx * scale, sx * scale, 0, sy * scale, -sx * cy * scale, cx * cy * scale, 0, 0, 0, 0, 1])
}

/** Upper-left 3×3 of a rotation(+uniform scale) matrix, normalised — the normal matrix for such models. */
export function normalMatrix(m: Float32Array): Float32Array {
  const s = Math.hypot(m[0], m[1], m[2]) || 1
  return new Float32Array([m[0] / s, m[1] / s, m[2] / s, m[4] / s, m[5] / s, m[6] / s, m[8] / s, m[9] / s, m[10] / s])
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return out
}

/** Hex colour (#rgb or #rrggbb) to linear-ish [0..1] RGB for shader uniforms. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6)
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/** Points on a tilted ring around the orb, used for the progress particles. */
export function ring(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    out.set([Math.cos(a) * radius, Math.sin(a * 3) * 0.04, Math.sin(a) * radius, i / count], i * 4)
  }
  return out
}
