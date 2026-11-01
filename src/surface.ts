import { closestPoint, Terrain, type ElevationData, type Point } from './geo';
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
  const visited = new Uint8Array(nodes.length);
  // Multi-source Dijkstra, seeded with every height; all graph edge costs are positive.
  for (let pass = 0; pass < nodes.length; pass++) {
    let index = -1, lowest = Infinity;
    for (let i = 0; i < heights.length; i++) if (!visited[i] && heights[i] < lowest) { index = i; lowest = heights[i]; }
    if (index < 0) break;
    visited[index] = 1;
    for (const edge of nodes[index].neighbors) {
      heights[edge.index] = Math.min(heights[edge.index], lowest + MAX_PROFILE_GRADE * edge.length);
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
  constructor(readonly source: Terrain, readonly roads: RoadNetwork) {
    const profiles = engineerProfile(source, roads);
    super(bake(source, profiles), source.origin);
    this.profiles = profiles;
  }
}
