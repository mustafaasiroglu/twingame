import { clipSegment, closestPoint, project, type Bounds, type Origin, type Point } from './geo';

export interface OsmNode { type: 'node'; id: number; lon: number; lat: number }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags: Record<string, string> }
export interface OsmData { elements: (OsmNode | OsmWay | { type: 'relation'; id: number })[] }
export interface RoadSegment { a: Point; b: Point; width: number; name: string; wayId: number; highway: string }
const widths: Record<string, number> = {
  primary: 12, primary_link: 8, secondary: 9, secondary_link: 8,
  tertiary: 8, tertiary_link: 7, residential: 7, unclassified: 7, living_street: 6.4, service: 6.4,
};
export const ROAD_OFFSET = 0.08;
export const VEHICLE_RADIUS = 2.15;

export function isDrivable(way: OsmWay): boolean {
  const t = way.tags;
  return Object.hasOwn(widths, t.highway) && !['no', 'private'].includes(t.access) &&
    !['no', 'private'].includes(t.motor_vehicle) && !['no', 'private'].includes(t.motorcar) &&
    !(t.bridge && t.bridge !== 'no') && !(t.tunnel && t.tunnel !== 'no') &&
    !(t.layer && Number(t.layer) !== 0);
}
export function roadWidth(tags: Record<string, string>): number {
  const explicit = Number(tags.width?.replace(/\s*m$/, ''));
  const lanes = Number(tags.lanes);
  return Math.max(6.4, Math.min(18, explicit > 0 ? explicit : lanes > 0 ? lanes * 3.2 : widths[tags.highway]));
}
const key = (p: Point) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`;

export function extractRoads(osm: OsmData, bounds: Bounds, origin: Origin): RoadSegment[] {
  const nodes = new Map(osm.elements.filter((e): e is OsmNode => e.type === 'node').map(n => [n.id, n]));
  const northWest = project(bounds.west, bounds.north, origin);
  const southEast = project(bounds.east, bounds.south, origin);
  // Keep full width of boundary capsules inside the downloaded terrain coverage.
  const min = { x: northWest.x + 10, z: northWest.z + 10 };
  const max = { x: southEast.x - 10, z: southEast.z - 10 };
  const segments: RoadSegment[] = [];
  for (const way of osm.elements) {
    if (way.type !== 'way' || !isDrivable(way)) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = nodes.get(way.nodes[i - 1]), b = nodes.get(way.nodes[i]);
      if (!a || !b) throw new Error(`OSM way ${way.id} is missing a source node`);
      const clipped = clipSegment(project(a.lon, a.lat, origin), project(b.lon, b.lat, origin), min, max);
      if (!clipped || Math.hypot(clipped[0].x - clipped[1].x, clipped[0].z - clipped[1].z) < 0.05) continue;
      segments.push({
        a: clipped[0], b: clipped[1], width: roadWidth(way.tags),
        name: way.tags.name || 'İsimsiz yol', wayId: way.id, highway: way.tags.highway,
      });
    }
  }
  const parent = new Map<string, string>();
  const root = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (k !== r) { const next = parent.get(k)!; parent.set(k, r); k = next; }
    return r;
  };
  for (const s of segments) parent.set(root(key(s.a)), root(key(s.b)));
  const lengths = new Map<string, number>();
  for (const s of segments) {
    const r = root(key(s.a));
    lengths.set(r, (lengths.get(r) || 0) + Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z));
  }
  const largest = [...lengths].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!largest) throw new Error('No connected drivable roads in the downloaded OSM data');
  return segments.filter(s => root(key(s.a)) === largest);
}

export class RoadNetwork<T extends RoadSegment = RoadSegment> {
  private readonly buckets = new Map<string, T[]>();
  readonly totalLength: number;
  constructor(readonly segments: T[], indexPadding = 3) {
    if (!segments.length) throw new Error('Road network is empty');
    this.totalLength = segments.reduce((sum, s) => sum + Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z), 0);
    for (const s of segments) {
      const pad = s.width / 2 + indexPadding;
      for (let x = Math.floor((Math.min(s.a.x, s.b.x) - pad) / 32); x <= Math.floor((Math.max(s.a.x, s.b.x) + pad) / 32); x++) {
        for (let z = Math.floor((Math.min(s.a.z, s.b.z) - pad) / 32); z <= Math.floor((Math.max(s.a.z, s.b.z) + pad) / 32); z++) {
          const k = `${x},${z}`;
          const bucket = this.buckets.get(k) || [];
          bucket.push(s);
          this.buckets.set(k, bucket);
        }
      }
    }
  }
  nearby(p: Point): T[] {
    return this.buckets.get(`${Math.floor(p.x / 32)},${Math.floor(p.z / 32)}`) || [];
  }
  contains(p: Point): boolean {
    return this.nearby(p).some(s => closestPoint(p, s.a, s.b).distance <= s.width / 2);
  }
  fits(p: Point, radius = VEHICLE_RADIUS): boolean {
    if (!this.contains(p)) return false;
    // Test the footprint against the union, not each road separately, so junctions stay open.
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      if (!this.contains({ x: p.x + Math.cos(angle) * radius, z: p.z + Math.sin(angle) * radius })) return false;
    }
    return true;
  }
  nearest(p: Point): { segment: T; point: Point; distance: number } {
    let best = this.segments[0];
    let closest = closestPoint(p, best.a, best.b);
    for (const s of this.segments) {
      const candidate = closestPoint(p, s.a, s.b);
      if (candidate.distance < closest.distance) { best = s; closest = candidate; }
    }
    return { segment: best, point: closest, distance: closest.distance };
  }
  spawn(origin: Origin): Point & { heading: number } {
    const target = project(28.97725, 41.01375, origin);
    const candidates = this.segments.filter(s => s.name.includes('Ankara') && Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z) > 8);
    const sorted = (candidates.length ? candidates : this.segments).map(segment => ({
      segment, distance: closestPoint(target, segment.a, segment.b).distance,
    })).sort((a, b) => a.distance - b.distance);
    for (const { segment } of sorted) {
      const point = closestPoint(target, segment.a, segment.b);
      if (this.fits(point)) return {
        x: point.x, z: point.z, heading: Math.atan2(segment.b.x - segment.a.x, segment.b.z - segment.a.z),
      };
    }
    throw new Error('No safe spawn fits the vehicle footprint');
  }
}
