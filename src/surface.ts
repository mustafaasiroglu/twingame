import { closestPoint, Terrain, unproject, type ElevationData, type Point } from './geo';
import { RoadNetwork, type RoadSegment } from './roads';

export const ROAD_GRID_METRES = 3;
export const PROFILE_STEP_METRES = 4;
export const MAX_PROFILE_GRADE = 0.12;
export const SHOULDER_BLEND_METRES = 18;
export interface GradedSegment extends RoadSegment { ha: number; hb: number; rawHa: number; rawHb: number }
interface ProfileNode extends Point { raw: number; neighbors: { index: number; length: number }[] }
const pointKey = (p: Point) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
const smoothstep = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

function envelope(values: number[], nodes: ProfileNode[]): number[] {
  const heights = [...values];
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {
    heap.push(item); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= item[0]) break; heap[i] = heap[p]; i = p; }
    heap[i] = item;
  };
  values.forEach((h, i) => push([h, i]));
  while (heap.length) {
    const [lowest, index] = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
        if (last[0] <= heap[child][0]) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    if (lowest !== heights[index]) continue;
    for (const edge of nodes[index].neighbors) {
      const next = lowest + MAX_PROFILE_GRADE * edge.length;
      if (next < heights[edge.index]) { heights[edge.index] = next; push([next, edge.index]); }
    }
  }
  return heights;
}

export function engineerProfile(source: Terrain, roads: RoadNetwork): GradedSegment[] {
  const nodes: ProfileNode[] = [], lookup = new Map<string, number>();
  const edges: { a: number; b: number; segment: RoadSegment }[] = [];
  const node = (point: Point) => {
    const key = pointKey(point), existing = lookup.get(key);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    lookup.set(key, index);
    nodes.push({ ...point, raw: source.height(point.x, point.z), neighbors: [] });
    return index;
  };
  for (const segment of roads.segments) {
    const length = Math.hypot(segment.b.x - segment.a.x, segment.b.z - segment.a.z);
    const steps = Math.ceil(length / PROFILE_STEP_METRES);
    let previous = node(segment.a);
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const current = node({
        x: segment.a.x + t * (segment.b.x - segment.a.x),
        z: segment.a.z + t * (segment.b.z - segment.a.z),
      });
      if (previous !== current) {
        const distance = Math.hypot(nodes[previous].x - nodes[current].x, nodes[previous].z - nodes[current].z);
        nodes[previous].neighbors.push({ index: current, length: distance });
        nodes[current].neighbors.push({ index: previous, length: distance });
        edges.push({ a: previous, b: current, segment });
      }
      previous = current;
    }
  }
  let heights = nodes.map(n => n.raw);
  for (let pass = 0; pass < 100; pass++) {
    heights = nodes.map(n => {
      let sum = 0, weight = 0;
      for (const edge of n.neighbors) {
        const w = 1 / edge.length;
        sum += heights[edge.index] * w; weight += w;
      }
      return n.raw * 0.02 + sum / weight * 0.98;
    });
  }
  const upper = envelope(heights, nodes);
  const lower = envelope(heights.map(h => -h), nodes).map(h => -h);
  heights = upper.map((h, i) => (h + lower[i]) / 2);
  return edges.map(edge => ({
    ...edge.segment, a: nodes[edge.a], b: nodes[edge.b],
    ha: heights[edge.a], hb: heights[edge.b], rawHa: nodes[edge.a].raw, rawHb: nodes[edge.b].raw,
  }));
}

function bake(source: Terrain, profiles: GradedSegment[]): ElevationData {
  const index = new RoadNetwork(profiles, SHOULDER_BLEND_METRES);
  const cols = Math.ceil((source.max.x - source.min.x) / ROAD_GRID_METRES) + 1;
  const rows = Math.ceil((source.max.z - source.min.z) / ROAD_GRID_METRES) + 1;
  const dx = (source.max.x - source.min.x) / (cols - 1), dz = (source.max.z - source.min.z) / (rows - 1);
  const values: number[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const point = { x: source.min.x + col * dx, z: source.min.z + row * dz };
    let weightedHeight = 0, weights = 0, influence = 0;
    for (const segment of index.nearby(point)) {
      const closest = closestPoint(point, segment.a, segment.b);
      const edgeDistance = closest.distance - segment.width / 2;
      const blend = smoothstep(1 - edgeDistance / SHOULDER_BLEND_METRES);
      if (blend === 0) continue;
      const weight = blend * Math.exp(-((closest.distance / (segment.width / 2 + 4)) ** 2));
      weightedHeight += (segment.ha + (segment.hb - segment.ha) * closest.t) * weight;
      weights += weight;
      influence = Math.max(influence, blend);
    }
    const raw = source.height(point.x, point.z);
    values.push(weights ? raw + (weightedHeight / weights - raw) * influence : raw);
  }
  return {
    cols, rows, west: source.data.west, north: source.data.north,
    stepLon: source.data.stepLon * (source.data.cols - 1) / (cols - 1),
    stepLat: source.data.stepLat * (source.data.rows - 1) / (rows - 1), values,
  };
}

export class RoadSurface extends Terrain {
  readonly profiles: GradedSegment[];
  readonly tiled: boolean;
  private readonly profileIndex: RoadNetwork<GradedSegment>;
  private readonly samples = new Map<number, number>();
  constructor(readonly source: Terrain, readonly roads: RoadNetwork, preparedProfiles?: GradedSegment[]) {
    const profiles = preparedProfiles || engineerProfile(source, roads);
    const tiled = source.max.x - source.min.x > 3000;
    super(tiled ? source.data : bake(source, profiles), source.origin);
    this.tiled = tiled;
    this.profiles = profiles;
    this.profileIndex = new RoadNetwork(profiles, SHOULDER_BLEND_METRES);
  }
  private sample(col: number, row: number): number {
    const cols = Math.ceil((this.max.x - this.min.x) / ROAD_GRID_METRES) + 1, key = row * cols + col;
    const cached = this.samples.get(key);
    if (cached !== undefined) return cached;
    const p = { x: Math.min(this.max.x, this.min.x + col * ROAD_GRID_METRES), z: Math.min(this.max.z, this.min.z + row * ROAD_GRID_METRES) };
    let sum = 0, weightSum = 0, influence = 0;
    for (const s of this.profileIndex.nearby(p)) {
      const nearest = closestPoint(p, s.a, s.b), blend = smoothstep(1 - (nearest.distance - s.width / 2) / SHOULDER_BLEND_METRES);
      if (blend === 0) continue;
      const weight = blend * Math.exp(-((nearest.distance / (s.width / 2 + 4)) ** 2));
      sum += (s.ha + (s.hb - s.ha) * nearest.t) * weight; weightSum += weight; influence = Math.max(influence, blend);
    }
    const raw = this.source.height(p.x, p.z), value = weightSum ? raw + (sum / weightSum - raw) * influence : raw;
    if (this.samples.size > 350000) this.samples.clear();
    this.samples.set(key, value);
    return value;
  }
  override height(x: number, z: number): number {
    if (!this.tiled) return super.height(x, z);
    if (x < this.min.x - 1e-7 || x > this.max.x + 1e-7 || z < this.min.z - 1e-7 || z > this.max.z + 1e-7) throw new Error('Position is outside the downloaded elevation coverage.');
    const u = (x - this.min.x) / ROAD_GRID_METRES, v = (z - this.min.z) / ROAD_GRID_METRES;
    const c = Math.max(0, Math.floor(u)), r = Math.max(0, Math.floor(v)), tx = u - c, tz = v - r;
    const a = this.sample(c, r), b = this.sample(c + 1, r), d = this.sample(c, r + 1), e = this.sample(c + 1, r + 1);
    return tx >= tz ? a + tx * (b - a) + tz * (e - b) : a + tz * (d - a) + tx * (e - d);
  }
  tile(col: number, row: number, step = 1, cells = 64): Terrain {
    const x = this.min.x + col * cells * ROAD_GRID_METRES, z = this.min.z + row * cells * ROAD_GRID_METRES;
    const cols = Math.min(cells / step, Math.floor((this.max.x - x) / (step * ROAD_GRID_METRES))) + 1;
    const rows = Math.min(cells / step, Math.floor((this.max.z - z) / (step * ROAD_GRID_METRES))) + 1;
    const geo = unproject({ x, z }, this.origin);
    const east = unproject({ x: x + step * ROAD_GRID_METRES, z }, this.origin), south = unproject({ x, z: z + step * ROAD_GRID_METRES }, this.origin);
    const values = Array.from({ length: cols * rows }, (_, i) => this.height(x + i % cols * step * ROAD_GRID_METRES, z + Math.floor(i / cols) * step * ROAD_GRID_METRES));
    return new Terrain({ cols, rows, west: geo.lon, north: geo.lat, stepLon: east.lon - geo.lon, stepLat: geo.lat - south.lat, values }, this.origin);
  }
}
