import { clipSegment, closestPoint, project, type Bounds, type Origin, type Point } from './geo';

export interface OsmNode { type: 'node'; id: number; lon: number; lat: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags: Record<string, string> }
export interface OsmRelation { type: 'relation'; id: number; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[] }
export interface OsmData { elements: (OsmNode | OsmWay | OsmRelation)[] }
export interface RoadSegment { a: Point; b: Point; width: number; name: string; wayId: number; highway: string; phase?: number; sidewalk?: string }
const widths: Record<string, number> = {
  primary: 12, primary_link: 8, secondary: 9, secondary_link: 8,
  tertiary: 8, tertiary_link: 7, residential: 7, unclassified: 7, living_street: 6.4, service: 6.4,
};
export const ROAD_OFFSET = 0.08;
export const VEHICLE_HALF_WIDTH = 1.05;
export const VEHICLE_HALF_LENGTH = 2;

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

export function extractRoads(osm: OsmData, bounds: Bounds, origin: Origin, radiusMetres?: number, largestOnly = true): RoadSegment[] {
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
      let clipped = clipSegment(project(a.lon, a.lat, origin), project(b.lon, b.lat, origin), min, max);
      if (clipped && radiusMetres) {
        const [p, q] = clipped, dx = q.x - p.x, dz = q.z - p.z;
        const aa = dx * dx + dz * dz, bb = 2 * (p.x * dx + p.z * dz), rr = radiusMetres - roadWidth(way.tags) / 2;
        const discriminant = bb * bb - 4 * aa * (p.x * p.x + p.z * p.z - rr * rr);
        if (discriminant < 0) clipped = null;
        else {
          const first = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa));
          const last = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
          clipped = first <= last ? [{ x: p.x + first * dx, z: p.z + first * dz }, { x: p.x + last * dx, z: p.z + last * dz }] : null;
        }
      }
      if (!clipped || Math.hypot(clipped[0].x - clipped[1].x, clipped[0].z - clipped[1].z) < 0.05) continue;
      segments.push({
        a: clipped[0], b: clipped[1], width: roadWidth(way.tags),
        name: way.tags.name || 'İsimsiz yol', wayId: way.id, highway: way.tags.highway,
        sidewalk: way.tags.sidewalk || (way.tags['sidewalk:both'] === 'yes' ? 'both' : way.tags['sidewalk:left'] === 'yes' ? 'left' : way.tags['sidewalk:right'] === 'yes' ? 'right' : undefined),
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
  const phases = new Map<number, number>();
  return segments.filter(s => !largestOnly || root(key(s.a)) === largest).map(s => {
    const phase = phases.get(s.wayId) || 0;
    phases.set(s.wayId, phase + Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z));
    return { ...s, phase };
  });
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
  fits(p: Point & { heading?: number }, heading = p.heading ?? 0): boolean {
    if (!this.contains(p)) return false;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const inside = (x: number, z: number) => this.contains({
      x: p.x + fz * x + fx * z, z: p.z - fx * x + fz * z,
    });
    // Sample the actual oriented body envelope against the union, including concave junction edges.
    const lengthSteps = Math.ceil(2 * VEHICLE_HALF_LENGTH / 0.25);
    const widthSteps = Math.ceil(2 * VEHICLE_HALF_WIDTH / 0.25);
    for (let i = 0; i <= lengthSteps; i++) {
      const z = -VEHICLE_HALF_LENGTH + 2 * VEHICLE_HALF_LENGTH * i / lengthSteps;
      if (!inside(-VEHICLE_HALF_WIDTH, z) || !inside(VEHICLE_HALF_WIDTH, z)) return false;
    }
    for (let i = 1; i < widthSteps; i++) {
      const x = -VEHICLE_HALF_WIDTH + 2 * VEHICLE_HALF_WIDTH * i / widthSteps;
      if (!inside(x, -VEHICLE_HALF_LENGTH) || !inside(x, VEHICLE_HALF_LENGTH)) return false;
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
    const target = { x: 0, z: 0 };
    const candidates = this.segments.filter(s => s.width >= 7.5 && Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z) > 12);
    const sorted = (candidates.length ? candidates : this.segments).map(segment => ({
      segment, distance: closestPoint(target, segment.a, segment.b).distance,
    })).sort((a, b) => a.distance - b.distance);
    const preferred = sorted.filter(({ segment: s, distance }) => distance < 250 && s.name !== 'İsimsiz yol' && s.name && s.highway !== 'service' && Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z) >= 50);
    // Start away from junctions on a nearby named street, not a palace driveway.
    for (const { segment } of [...preferred, ...sorted]) {
      const point = preferred.some(p => p.segment === segment)
        ? { x: (segment.a.x + segment.b.x) / 2, z: (segment.a.z + segment.b.z) / 2 }
        : closestPoint(target, segment.a, segment.b);
      const pose = {
        x: point.x, z: point.z, heading: Math.atan2(segment.b.x - segment.a.x, segment.b.z - segment.a.z),
      };
      if (-point.x * Math.sin(pose.heading) - point.z * Math.cos(pose.heading) < 0) pose.heading += Math.PI;
      if (this.fits(pose)) return pose;
    }
    throw new Error('No safe spawn fits the vehicle footprint');
  }
}
