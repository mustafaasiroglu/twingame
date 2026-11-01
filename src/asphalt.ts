import * as THREE from 'three';

export const ASPHALT_TILE_METRES = 4;
export function asphaltUV(vertices: number[]): Float32Array {
  const uv = new Float32Array(vertices.length / 3 * 2);
  for (let i = 0; i < vertices.length / 3; i++) {
    uv[i * 2] = vertices[i * 3] / ASPHALT_TILE_METRES;
    uv[i * 2 + 1] = vertices[i * 3 + 2] / ASPHALT_TILE_METRES;
  }
  return uv;
}

export function asphaltTextures(base: THREE.Color, anisotropy: number): { map: THREE.DataTexture; grain: THREE.DataTexture } {
  const size = 128, color = new Uint8Array(size * size * 4), grain = new Uint8Array(size * size * 4);
  const srgb = base.clone().convertLinearToSRGB();
  let seed = 934157;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const noise = (x: number, y: number, cells: number) => {
    const u = x / size * cells, v = y / size * cells, ix = Math.floor(u), iy = Math.floor(v);
    const sx = (u - ix) ** 2 * (3 - 2 * (u - ix)), sy = (v - iy) ** 2 * (3 - 2 * (v - iy));
    const hash = (a: number, b: number) => {
      let h = Math.imul((a % cells) + 17, 374761393) ^ Math.imul((b % cells) + 31, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const a = hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx;
    const b = hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx;
    return a * (1 - sy) + b * sy;
  };
  for (let i = 0; i < size * size; i++) {
    const aggregate = random(), fine = random();
    const x = i % size, y = Math.floor(i / size);
    const brightness = 0.78 + noise(x, y, 4) * 0.17 + noise(x, y, 16) * 0.15 + aggregate * 0.08 + fine * 0.04;
    color[i * 4] = Math.min(255, Math.round(srgb.r * brightness * 255));
    color[i * 4 + 1] = Math.min(255, Math.round(srgb.g * brightness * 255));
    color[i * 4 + 2] = Math.min(255, Math.round(srgb.b * brightness * 255));
    color[i * 4 + 3] = 255;
    const rough = Math.round(190 + aggregate * 65);
    grain.set([rough, rough, rough, 255], i * 4);
  }
  const texture = (data: Uint8Array, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.DataTexture(data, size, size);
    t.colorSpace = colorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(8, anisotropy);
    t.needsUpdate = true;
    return t;
  };
  return { map: texture(color, THREE.SRGBColorSpace), grain: texture(grain, THREE.NoColorSpace) };
}
