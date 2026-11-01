import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import { closestPoint, project, type Origin, type Point } from './geo';
import { RoadNetwork, type OsmData, type OsmNode, type OsmWay, type RoadSegment } from './roads';

export type AreaKind = 'building' | 'part' | 'green' | 'water' | 'paved';
export interface AreaFeature {
  id: string; kind: AreaKind; tags: Record<string, string>; polygons: MultiPolygon;
  min: Point; max: Point; height: number; minHeight: number; heightSource: 'height' | 'levels' | 'default';
}
export interface PathFeature { id: string; points: Point[]; width: number; sidewalk: boolean }
export interface TreeFeature extends Point { id: string; height: number; source: 'node' | 'row' | 'inferred' }
export interface FeatureData {
  areas: AreaFeature[]; paths: PathFeature[]; trees: TreeFeature[]; rows: PathFeature[];
  incomplete: string[]; radiusMetres: number; clearancePaths?: PathFeature[];
}
export function pointInRing(p: Point, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p.z) !== (b[1] > p.z) && p.x < (b[0] - a[0]) * (p.z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function inside(p: Point, polygons: MultiPolygon): boolean {
  return polygons.some(polygon => pointInRing(p, polygon[0]) && !polygon.slice(1).some(hole => pointInRing(p, hole)));
}
export function metres(value?: string): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i);
  if (!match) return undefined;
  const result = Number(match[1]) * (match[2] && match[2].toLowerCase() !== 'm' ? 0.3048 : 1);
  return result > 0 && result <= 300 ? result : undefined;
}
export function buildingHeight(tags: Record<string, string>) {
  const height = metres(tags.height), levels = Number(tags['building:levels']);
  const minHeight = metres(tags.min_height) ?? (Number(tags['building:min_level']) > 0 ? Number(tags['building:min_level']) * 3 : 0);
  const inferred = levels > 0 && levels <= 80 ? levels * 3 + (metres(tags['roof:height']) || 0) : 9;
  const usableHeight = height !== undefined && height > minHeight ? height : undefined;
  return { height: Math.max(usableHeight ?? inferred, minHeight + 1), minHeight, heightSource: usableHeight ? 'height' as const : levels > 0 && levels <= 80 && inferred > minHeight ? 'levels' as const : 'default' as const };
}
function kind(tags: Record<string, string>): AreaKind | undefined {
  if (tags['building:part'] && tags['building:part'] !== 'no') return 'part';
  if (tags.building && tags.building !== 'no') return 'building';
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return 'water';
  if (['park', 'garden', 'nature_reserve', 'recreation_ground', 'pitch'].includes(tags.leisure) ||
      ['forest', 'grass', 'meadow', 'village_green', 'recreation_ground'].includes(tags.landuse) ||
      ['wood', 'scrub'].includes(tags.natural)) return 'green';
  if (tags.area === 'yes' && ['pedestrian', 'footway', 'path'].includes(tags.highway)) return 'paved';
}
export function joinRings(parts: number[][]): { rings: number[][]; complete: boolean } {
  const remaining = parts.map(p => [...p]), rings: number[][] = [];
  while (remaining.length) {
    const ring = remaining.shift()!;
    while (ring[0] !== ring[ring.length - 1]) {
      const last = ring[ring.length - 1], next = remaining.findIndex(p => p[0] === last || p[p.length - 1] === last);
      if (next < 0) return { rings, complete: false };
      const piece = remaining.splice(next, 1)[0];
      if (piece[0] !== last) piece.reverse();
      ring.push(...piece.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return { rings, complete: true };
}
export class SpatialIndex<T extends { min: Point; max: Point }> {
  private buckets = new Map<string, T[]>();
  constructor(items: T[], private size = 192) {
    for (const item of items) for (let x = Math.floor(item.min.x / size); x <= Math.floor(item.max.x / size); x++) {
      for (let z = Math.floor(item.min.z / size); z <= Math.floor(item.max.z / size); z++) {
        const key = `${x},${z}`, bucket = this.buckets.get(key) || []; bucket.push(item); this.buckets.set(key, bucket);
      }
    }
  }
  at(p: Point): T[] { return this.buckets.get(`${Math.floor(p.x / this.size)},${Math.floor(p.z / this.size)}`) || []; }
  box(min: Point, max: Point): T[] {
    const result = new Set<T>();
    for (let x = Math.floor(min.x / this.size); x <= Math.floor(max.x / this.size); x++) for (let z = Math.floor(min.z / this.size); z <= Math.floor(max.z / this.size); z++) {
      for (const item of this.buckets.get(`${x},${z}`) || []) if (item.max.x >= min.x && item.min.x <= max.x && item.max.z >= min.z && item.min.z <= max.z) result.add(item);
    }
    return [...result];
  }
}
export function box(points: Point[]) {
  return { min: { x: Math.min(...points.map(p => p.x)), z: Math.min(...points.map(p => p.z)) }, max: { x: Math.max(...points.map(p => p.x)), z: Math.max(...points.map(p => p.z)) } };
}
export function extractFeatures(osm: OsmData, origin: Origin, radiusMetres: number): FeatureData {
  const nodes = new Map(osm.elements.filter((e): e is OsmNode => e.type === 'node').map(n => [n.id, n]));
  const ways = new Map(osm.elements.filter((e): e is OsmWay => e.type === 'way').map(w => [w.id, w]));
  const areas: AreaFeature[] = [], paths: PathFeature[] = [], rows: PathFeature[] = [], trees: TreeFeature[] = [], incomplete: string[] = [];
  const clearancePaths: PathFeature[] = [];
  const circle: Polygon = [Array.from({ length: 129 }, (_, i): [number, number] => [Math.cos(i * Math.PI / 64) * radiusMetres, Math.sin(i * Math.PI / 64) * radiusMetres])];
  const consumed = new Set<number>();
  const coordinates = (ids: number[]): [number, number][] | undefined => {
    if (ids.some(id => !nodes.has(id))) return undefined;
    return ids.map(id => { const n = nodes.get(id)!, p = project(n.lon, n.lat, origin); return [p.x, p.z]; });
  };
  const addArea = (id: string, tags: Record<string, string>, polygons: MultiPolygon) => {
    const type = kind(tags);
    if (!type || !polygons.length) return;
    const originalPoints = polygons.flatMap(p => p[0].map(v => ({ x: v[0], z: v[1] })));
    const bounds = box(originalPoints);
    const nx = Math.max(bounds.min.x, Math.min(0, bounds.max.x)), nz = Math.max(bounds.min.z, Math.min(0, bounds.max.z));
    if (Math.hypot(nx, nz) > radiusMetres) return;
    const clipped = originalPoints.every(p => Math.hypot(p.x, p.z) <= radiusMetres) ? polygons : polygonClipping.intersection(polygons, circle);
    if (!clipped.length) return;
    const points = clipped.flatMap(p => p[0].map(v => ({ x: v[0], z: v[1] })));
    areas.push({ id, kind: type, tags, polygons: clipped, ...box(points), ...buildingHeight(tags) });
  };
  for (const relation of osm.elements) {
    if (relation.type !== 'relation' || relation.tags?.type !== 'multipolygon' || !kind(relation.tags)) continue;
    const members = relation.members?.filter(m => m.type === 'way') || [];
    members.forEach(m => consumed.add(m.ref));
    if (!members.length || members.some(m => !ways.has(m.ref))) { incomplete.push(`relation/${relation.id}: missing member ways`); continue; }
    const outers = joinRings(members.filter(m => m.role !== 'inner').map(m => ways.get(m.ref)!.nodes));
    const inners = joinRings(members.filter(m => m.role === 'inner').map(m => ways.get(m.ref)!.nodes));
    const outerCoordinates = outers.rings.map(coordinates), innerCoordinates = inners.rings.map(coordinates);
    if (!outers.complete || !inners.complete || outerCoordinates.some(p => !p) || innerCoordinates.some(p => !p)) { incomplete.push(`relation/${relation.id}: unclosed rings or missing nodes`); continue; }
    const polygons: MultiPolygon = outerCoordinates.map(outer => [outer!]);
    let holesValid = true;
    for (const inner of innerCoordinates) {
      const target = polygons.find(p => pointInRing({ x: inner![0][0], z: inner![0][1] }, p[0]));
      if (target) target.push(inner!); else { incomplete.push(`relation/${relation.id}: unassigned inner ring`); holesValid = false; }
    }
    if (holesValid) addArea(`relation/${relation.id}`, relation.tags, polygons);
    members.forEach(m => consumed.add(m.ref));
  }
  for (const way of ways.values()) {
    const points = coordinates(way.nodes);
    if (!points) { if (kind(way.tags) || way.tags.highway) incomplete.push(`way/${way.id}: missing nodes`); continue; }
    if (kind(way.tags) && !consumed.has(way.id)) {
      if (way.nodes[0] === way.nodes[way.nodes.length - 1]) addArea(`way/${way.id}`, way.tags, [[points]]);
      else incomplete.push(`way/${way.id}: area ring is not closed`);
    }
    if (['footway', 'path', 'pedestrian', 'steps', 'cycleway'].includes(way.tags.highway) && way.tags.area !== 'yes') {
      if ((!way.tags.bridge || way.tags.bridge === 'no') && (!way.tags.tunnel || way.tags.tunnel === 'no') && (!way.tags.layer || Number(way.tags.layer) === 0)) paths.push({ id: `way/${way.id}`, points: points.map(v => ({ x: v[0], z: v[1] })), width: metres(way.tags.width) || 1.8, sidewalk: way.tags.footway === 'sidewalk' });
    }
    if (['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service', 'living_street', 'primary_link', 'secondary_link', 'tertiary_link'].includes(way.tags.highway)) clearancePaths.push({ id: `way/${way.id}`, points: points.map(v => ({ x: v[0], z: v[1] })), width: metres(way.tags.width) || (Number(way.tags.lanes) > 0 ? Number(way.tags.lanes) * 3.2 : 6.4), sidewalk: false });
    if (way.tags.natural === 'tree_row') rows.push({ id: `way/${way.id}`, points: points.map(v => ({ x: v[0], z: v[1] })), width: 1, sidewalk: false });
  }
  for (const node of nodes.values()) if (node.tags?.natural === 'tree') {
    const p = project(node.lon, node.lat, origin);
    if (Math.hypot(p.x, p.z) <= radiusMetres) trees.push({ ...p, id: `node/${node.id}`, source: 'node', height: metres(node.tags.height) || 8 });
  }
  areas.sort((a, b) => a.id.localeCompare(b.id));
  return { areas, paths, trees, rows, incomplete, radiusMetres, clearancePaths };
}
export function treeEligible(area: AreaFeature): boolean {
  return area.kind === 'green' && area.tags.leisure !== 'pitch' && !['grass', 'meadow'].includes(area.tags.landuse) &&
    area.tags.landcover !== 'grass' && area.tags.surface !== 'grass' &&
    (['park', 'garden', 'nature_reserve'].includes(area.tags.leisure) || area.tags.natural === 'wood' || area.tags.landuse === 'forest');
}
function hash(text: string): number { let result = 2166136261; for (const c of text) { result ^= c.charCodeAt(0); result = Math.imul(result, 16777619); } return result >>> 0; }
export function inferTrees(data: FeatureData, roads: RoadNetwork): TreeFeature[] {
  const result = [...data.trees].sort((a, b) => a.id.localeCompare(b.id));
  const occupied = new Map<string, TreeFeature[]>();
  const key = (x: number, z: number) => `${Math.floor(x / 5)},${Math.floor(z / 5)}`;
  const add = (t: TreeFeature) => { const k = key(t.x, t.z), list = occupied.get(k) || []; list.push(t); occupied.set(k, list); };
  const nearby = (p: Point) => {
    const found: TreeFeature[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) found.push(...(occupied.get(key(p.x + dx * 5, p.z + dz * 5)) || []));
    return found;
  };
  result.forEach(add);
  for (const row of data.rows) for (let i = 1; i < row.points.length; i++) {
    const a = row.points[i - 1], b = row.points[i], count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8));
    for (let j = 0; j < count; j++) {
      const p = { x: a.x + (b.x - a.x) * j / count, z: a.z + (b.z - a.z) * j / count };
      if (Math.hypot(p.x, p.z) > data.radiusMetres || nearby(p).some(t => Math.hypot(t.x - p.x, t.z - p.z) < 5)) continue;
      const t: TreeFeature = { ...p, id: `${row.id}/${i}/${j}`, height: 8, source: 'row' }; result.push(t); add(t);
    }
  }
  const blockers = new SpatialIndex(data.areas.filter(a => ['building', 'part', 'water', 'paved'].includes(a.kind)).map(a => ({ ...a, min: { x: a.min.x - 3, z: a.min.z - 3 }, max: { x: a.max.x + 3, z: a.max.z + 3 } })));
  const pathSegments = [...data.paths, ...(data.clearancePaths || [])].flatMap(path => path.points.slice(1).map((b, i) => ({ a: path.points[i], b, width: path.width, name: '', wayId: i, highway: 'footway' })));
  const paths = pathSegments.length ? new RoadNetwork(pathSegments, 3) : null;
  const mapped = new SpatialIndex(result.map(t => ({ ...t, min: t, max: t })));
  for (const green of [...data.areas].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!treeEligible(green) || mapped.box(green.min, green.max).some(t => inside(t, green.polygons))) continue;
    for (let x = Math.floor(green.min.x / 10) * 10; x <= green.max.x; x += 10) for (let z = Math.floor(green.min.z / 10) * 10; z <= green.max.z; z += 10) {
      const seed = hash(`${green.id}/${x}/${z}`);
      if (seed % 100 > (green.tags.natural === 'wood' || green.tags.landuse === 'forest' ? 70 : 35)) continue;
      const p = { x: x + ((seed >>> 8) % 1000) / 100 - 5, z: z + ((seed >>> 18) % 1000) / 100 - 5 };
      if (!inside(p, green.polygons) || nearby(p).some(t => Math.hypot(t.x - p.x, t.z - p.z) < 5)) continue;
      if (roads.nearby(p).some(s => closestPoint(p, s.a, s.b).distance < s.width / 2 + 4)) continue;
      if (paths?.nearby(p).some(s => closestPoint(p, s.a, s.b).distance < s.width / 2 + 3)) continue;
      if (blockers.at(p).some(a => inside(p, a.polygons) || a.polygons.some(poly => poly.some(ring => ring.slice(1).some((v, i) => closestPoint(p, { x: ring[i][0], z: ring[i][1] }, { x: v[0], z: v[1] }).distance < 3))))) continue;
      const t: TreeFeature = { ...p, id: `${green.id}/inferred/${x}/${z}`, height: 6 + seed % 300 / 100, source: 'inferred' };
      result.push(t); add(t);
    }
  }
  return result;
}
export function pathSegments(paths: PathFeature[]): RoadSegment[] {
  return paths.flatMap(path => path.points.slice(1).map((b, i) => ({ a: path.points[i], b, width: path.width, name: path.id, wayId: i, highway: 'footway' })));
}
export function sidewalks(roads: RoadNetwork): { segments: RoadSegment[]; mapped: number; inferred: number } {
  const segments: RoadSegment[] = []; let mapped = 0, inferred = 0;
  for (const s of roads.segments) {
    if (['no', 'none', 'separate'].includes(s.sidewalk || '') || (!s.sidewalk && ['service', 'primary_link', 'secondary_link', 'tertiary_link'].includes(s.highway))) continue;
    const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, length = Math.hypot(dx, dz);
    const sides = s.sidewalk === 'left' ? [-1] : s.sidewalk === 'right' ? [1] : [-1, 1];
    for (const sign of sides) {
      const ox = dz / length * (s.width / 2 + 0.75) * sign, oz = -dx / length * (s.width / 2 + 0.75) * sign;
      segments.push({ ...s, a: { x: s.a.x + ox, z: s.a.z + oz }, b: { x: s.b.x + ox, z: s.b.z + oz }, width: 1.5 });
    }
    if (s.sidewalk) mapped++; else inferred++;
  }
  return { segments, mapped, inferred };
}
