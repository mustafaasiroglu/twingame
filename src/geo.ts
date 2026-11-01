export interface Point { x: number; z: number }
export interface Origin { lon: number; lat: number }
export interface Bounds { west: number; east: number; south: number; north: number }
export interface ElevationData {
  cols: number; rows: number; west: number; north: number;
  stepLon: number; stepLat: number; values: number[];
}
export const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

export function project(lon: number, lat: number, origin: Origin): Point {
  return {
    x: (lon - origin.lon) * RAD * EARTH_RADIUS * Math.cos(origin.lat * RAD),
    z: -(lat - origin.lat) * RAD * EARTH_RADIUS,
  };
}

export function unproject(point: Point, origin: Origin): Origin {
  return {
    lon: origin.lon + point.x / (RAD * EARTH_RADIUS * Math.cos(origin.lat * RAD)),
    lat: origin.lat - point.z / (RAD * EARTH_RADIUS),
  };
}

export class Terrain {
  readonly min: Point;
  readonly max: Point;
  readonly dx: number;
  readonly dz: number;
  constructor(readonly data: ElevationData, readonly origin: Origin) {
    if (!Number.isInteger(data.cols) || !Number.isInteger(data.rows) ||
        ![data.west, data.north, data.stepLon, data.stepLat, origin.lon, origin.lat].every(Number.isFinite) ||
        data.cols < 2 || data.rows < 2 || data.stepLon <= 0 || data.stepLat <= 0 ||
        data.values.length !== data.cols * data.rows || data.values.some(v => !Number.isFinite(v))) {
      throw new Error('Invalid or missing elevation raster. No flat fallback is available.');
    }
    this.min = project(data.west, data.north, origin);
    this.max = project(data.west + (data.cols - 1) * data.stepLon, data.north - (data.rows - 1) * data.stepLat, origin);
    this.dx = (this.max.x - this.min.x) / (data.cols - 1);
    this.dz = (this.max.z - this.min.z) / (data.rows - 1);
  }
  vertex(col: number, row: number): Point {
    return { x: this.min.x + col * this.dx, z: this.min.z + row * this.dz };
  }
  height(x: number, z: number): number {
    const u = (x - this.min.x) / this.dx;
    const v = (z - this.min.z) / this.dz;
    if (u < -1e-8 || v < -1e-8 || u > this.data.cols - 1 + 1e-8 || v > this.data.rows - 1 + 1e-8) {
      throw new Error('Position is outside the downloaded elevation coverage.');
    }
    const c = Math.max(0, Math.min(this.data.cols - 2, Math.floor(u)));
    const r = Math.max(0, Math.min(this.data.rows - 2, Math.floor(v)));
    const a = this.data.values[r * this.data.cols + c];
    const b = this.data.values[r * this.data.cols + c + 1];
    const d = this.data.values[(r + 1) * this.data.cols + c];
    const e = this.data.values[(r + 1) * this.data.cols + c + 1];
    const tx = Math.max(0, Math.min(1, u - c));
    const tz = Math.max(0, Math.min(1, v - r));
    // Same a--e diagonal and barycentric interpolation as both rendered meshes.
    return tx >= tz ? a + tx * (b - a) + tz * (e - b) : a + tz * (d - a) + tx * (e - d);
  }
}

export function closestPoint(p: Point, a: Point, b: Point): Point & { t: number; distance: number } {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2));
  const x = a.x + t * dx, z = a.z + t * dz;
  return { x, z, t, distance: Math.hypot(p.x - x, p.z - z) };
}

export function clipSegment(a: Point, b: Point, min: Point, max: Point): [Point, Point] | null {
  const dx = b.x - a.x, dz = b.z - a.z;
  let first = 0, last = 1;
  for (const [p, q] of [[-dx, a.x - min.x], [dx, max.x - a.x], [-dz, a.z - min.z], [dz, max.z - a.z]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) first = Math.max(first, t);
    else last = Math.min(last, t);
    if (first > last) return null;
  }
  return [{ x: a.x + first * dx, z: a.z + first * dz }, { x: a.x + last * dx, z: a.z + last * dz }];
}
