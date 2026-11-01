import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import elevation from '../public/data/elevation.json';
import provenance from '../public/data/provenance.json';
import osm from '../public/data/osm-source.json';
import { Terrain, type Point } from '../src/geo';
import { extractRoads, RoadNetwork, ROAD_OFFSET, type OsmData, type RoadSegment } from '../src/roads';
import { engineerProfile, MAX_PROFILE_GRADE, ROAD_GRID_METRES, RoadSurface, SHOULDER_BLEND_METRES } from '../src/surface';
import { roadMarkings, roadPolygons, roadVertices, surfaceVertices, MARKING_LIFT } from '../src/scene';
import { createVehicle, sampleVehiclePose, stepVehicle, vehicleBasis } from '../src/vehicle';
import { asphaltUV, ASPHALT_TILE_METRES } from '../src/asphalt';

const segment = (a: Point, b: Point, wayId = 1): RoadSegment => ({ a, b, width: 8, wayId, name: 'Fixture', highway: 'secondary' });
function fixture(height: (x: number, z: number) => number): Terrain {
  const data = { cols: 41, rows: 41, west: -0.002, north: 0.002, stepLon: 0.0001, stepLat: 0.0001, values: Array<number>(41 * 41).fill(0) };
  const blank = new Terrain(data, { lat: 0, lon: 0 });
  data.values = data.values.map((_, i) => { const p = blank.vertex(i % 41, Math.floor(i / 41)); return height(p.x, p.z); });
  return new Terrain(data, blank.origin);
}
const straight = new RoadNetwork([segment({ x: 0, z: -180 }, { x: 0, z: 180 })]);
const source = new Terrain(elevation, provenance.origin);
const realRoads = new RoadNetwork(extractRoads(osm as OsmData, provenance.bounds, provenance.origin));
const realSurface = new RoadSurface(source, realRoads);

describe('vehicle slopes and actual rendered orientation', () => {
  it('raises the right side when ground rises right, including negative bank', () => {
    for (const crossSlope of [-0.2, 0.2]) {
      const terrain = fixture((x, z) => crossSlope * x + 0.1 * z);
      const pose = createVehicle({ x: 0, z: 0, heading: 0 }, terrain);
      expect(Math.tan(pose.roll)).toBeCloseTo(crossSlope, 8);
      expect(Math.tan(pose.pitch)).toBeCloseTo(0.1, 8);
      const basis = vehicleBasis(pose.pitch, pose.roll);
      expect(Math.sign(basis.right[1])).toBe(Math.sign(crossSlope));
      expect(basis.forward[1]).toBeGreaterThan(0);
    }
  });
  it('matches the terrain tangent plane after yaw at all headings, not reversed Euler lean', () => {
    const terrain = fixture((x, z) => 0.15 * x - 0.12 * z);
    for (const heading of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const pose = sampleVehiclePose({ x: 0, z: 0 }, heading, terrain);
      const basis = vehicleBasis(pose.pitch, pose.roll);
      const matrix = new Matrix4().makeBasis(new Vector3(...basis.right), new Vector3(...basis.up), new Vector3(...basis.forward));
      const local = new Quaternion().setFromRotationMatrix(matrix);
      const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading);
      const rotation = yaw.multiply(local);
      for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 0, 1)]) {
        const v = axis.applyQuaternion(rotation);
        expect(v.y).toBeCloseTo(0.15 * v.x - 0.12 * v.z, 8);
      }
      const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
      expect(up.dot(new Vector3(-0.15, 1, 0.12).normalize())).toBeCloseTo(1, 8);
    }
  });
});

describe('source-derived engineered roads', () => {
  it('smooths sharp DSM bumps and bounds graph grades while sharing junction elevations', () => {
    const terrain = fixture((x, z) => 0.04 * z + 32 * Math.exp(-(x * x + z * z) / 160));
    const cross = new RoadNetwork([...straight.segments, segment({ x: -160, z: 0 }, { x: 160, z: 0 }, 2)]);
    const profiles = engineerProfile(terrain, cross);
    let rawPeak = 0, engineeredPeak = 0;
    const levels = new Map<string, number>();
    for (const p of profiles) {
      const length = Math.hypot(p.b.x - p.a.x, p.b.z - p.a.z);
      rawPeak = Math.max(rawPeak, Math.abs(p.rawHb - p.rawHa) / length);
      engineeredPeak = Math.max(engineeredPeak, Math.abs(p.hb - p.ha) / length);
      for (const [point, h] of [[p.a, p.ha], [p.b, p.hb]] as const) {
        const key = `${point.x.toFixed(4)},${point.z.toFixed(4)}`;
        if (levels.has(key)) expect(h).toBeCloseTo(levels.get(key)!, 8);
        levels.set(key, h);
      }
    }
    expect(rawPeak).toBeGreaterThan(0.5);
    expect(engineeredPeak).toBeLessThanOrEqual(MAX_PROFILE_GRADE + 1e-8);
    expect(profiles.some(p => Math.abs(p.ha - p.rawHa) > 5)).toBe(true);
  });
  it('reduces crossfall, keeps broad longitudinal hills and leaves distant source terrain unchanged', () => {
    const terrain = fixture((x, z) => 0.25 * x + 0.08 * z);
    const originals = [...terrain.data.values];
    const surface = new RoadSurface(terrain, straight);
    expect(Math.abs(surface.height(2, 0) - surface.height(-2, 0))).toBeLessThan(0.08);
    expect(surface.height(0, 100) - surface.height(0, -100)).toBeGreaterThan(10);
    for (let r = 0; r < surface.data.rows; r += 13) for (let c = 0; c < surface.data.cols; c += 13) {
      const p = surface.vertex(c, r);
      if (Math.abs(p.x) > 4 + SHOULDER_BLEND_METRES) expect(surface.height(p.x, p.z)).toBeCloseTo(terrain.height(p.x, p.z), 8);
    }
    expect(terrain.data.values).toEqual(originals);
  });
  it('reduces measured road slopes on the actual dataset without flattening the world', () => {
    let raw = 0, graded = 0, crossRaw = 0, crossGraded = 0, count = 0;
    for (const s of realRoads.segments) {
      const length = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
      if (length < 8) continue;
      const fx = (s.b.x - s.a.x) / length, fz = (s.b.z - s.a.z) / length;
      const x = (s.a.x + s.b.x) / 2, z = (s.a.z + s.b.z) / 2;
      const grade = (t: Terrain) => (t.height(x + fx, z + fz) - t.height(x - fx, z - fz)) / 2;
      const cross = (t: Terrain) => (t.height(x + fz * 2, z - fx * 2) - t.height(x - fz * 2, z + fx * 2)) / 4;
      raw += grade(source) ** 2; graded += grade(realSurface) ** 2;
      crossRaw += cross(source) ** 2; crossGraded += cross(realSurface) ** 2; count++;
    }
    console.log('Real road RMS grades:', { source: Math.sqrt(raw / count), engineered: Math.sqrt(graded / count), crossSource: Math.sqrt(crossRaw / count), crossEngineered: Math.sqrt(crossGraded / count) });
    expect(graded).toBeLessThan(raw * 0.65 ** 2);
    expect(crossGraded).toBeLessThan(crossRaw * 0.7 ** 2);
    let distantSamples = 0;
    for (let r = 0; r < realSurface.data.rows; r += 17) for (let c = 0; c < realSurface.data.cols; c += 17) {
      const p = realSurface.vertex(c, r);
      if (realRoads.nearest(p).distance > 30) {
        expect(realSurface.height(p.x, p.z)).toBeCloseTo(source.height(p.x, p.z), 7); distantSamples++;
      }
    }
    expect(distantSamples).toBeGreaterThan(100);
    const maximum = realSurface.data.values.reduce((max, v) => Math.max(max, v), -Infinity);
    const minimum = realSurface.data.values.reduce((min, v) => Math.min(min, v), Infinity);
    expect(maximum - minimum).toBeGreaterThan(40);
  });
  it('uses fine cells and one continuous interpolation for rendered roads, paint and driving', () => {
    expect(realSurface.dx).toBeLessThanOrEqual(ROAD_GRID_METRES);
    expect(realSurface.dz).toBeLessThanOrEqual(ROAD_GRID_METRES);
    const polygons = roadPolygons(realRoads.segments.slice(0, 6));
    const vertices = roadVertices(realSurface, polygons);
    expect(vertices.length).toBeGreaterThan(500);
    for (let i = 0; i < vertices.length; i += 9) {
      const cx = (vertices[i] + vertices[i + 3] + vertices[i + 6]) / 3;
      const cz = (vertices[i + 2] + vertices[i + 5] + vertices[i + 8]) / 3;
      const cy = (vertices[i + 1] + vertices[i + 4] + vertices[i + 7]) / 3;
      expect(cy).toBeCloseTo(realSurface.height(cx, cz) + ROAD_OFFSET, 7);
      for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
        expect(Math.hypot(vertices[i + a] - vertices[i + b], vertices[i + a + 2] - vertices[i + b + 2])).toBeLessThanOrEqual(Math.hypot(realSurface.dx, realSurface.dz) + 1e-7);
      }
    }
    const p = realSurface.vertex(180, 170);
    expect(Math.abs(realSurface.height(p.x + 1e-5, p.z) - realSurface.height(p.x - 1e-5, p.z))).toBeLessThan(0.001);
    const wide = realRoads.segments.filter(s => s.width >= 7.5 && Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z) > 20).slice(0, 6);
    const marks = roadMarkings(new RoadNetwork(wide));
    const paint = surfaceVertices(realSurface, marks.polygons, ROAD_OFFSET + MARKING_LIFT);
    expect(paint.length).toBeGreaterThan(0);
    for (let i = 0; i < paint.length; i += 9) {
      const x = (paint[i] + paint[i + 3] + paint[i + 6]) / 3, z = (paint[i + 2] + paint[i + 5] + paint[i + 8]) / 3;
      expect((paint[i + 1] + paint[i + 4] + paint[i + 7]) / 3 - realSurface.height(x, z) - ROAD_OFFSET).toBeCloseTo(MARKING_LIFT, 7);
    }
  });
  it('preserves dash phase across short OSM segments rather than dropping their markings', () => {
    const pieces = new RoadNetwork(Array.from({ length: 20 }, (_, i) => segment({ x: 0, z: i * 2 }, { x: 0, z: (i + 1) * 2 })));
    const marks = roadMarkings(pieces);
    let area = 0;
    for (const polygon of marks.polygons) {
      const ring = polygon[0];
      area += Math.abs(ring.reduce((sum, p, i) => { const next = ring[(i + 1) % ring.length]; return sum + p[0] * next[1] - next[0] * p[1]; }, 0)) / 2;
    }
    expect(area).toBeCloseTo(0.18 * 16, 6);
    expect(marks.centers.length).toBeGreaterThan(0);
  });
  it('maps asphalt in world metres without stretching it per road segment', () => {
    const uv = asphaltUV([0, 10, 0, ASPHALT_TILE_METRES, 20, ASPHALT_TILE_METRES]);
    expect([...uv]).toEqual([0, 0, 1, 1]);
  });
  it('keeps actual junction heights continuous and the driven vehicle on the engineered surface', () => {
    const joints = new Map<string, { point: Point; count: number }>();
    for (const segment of realRoads.segments) for (const point of [segment.a, segment.b]) {
      const key = `${point.x.toFixed(4)},${point.z.toFixed(4)}`;
      joints.set(key, { point, count: (joints.get(key)?.count || 0) + 1 });
    }
    const busy = [...joints.values()].filter(j => j.count >= 3);
    expect(busy.length).toBeGreaterThan(5);
    for (const { point: p } of busy) {
      expect(Math.abs(realSurface.height(p.x + 1e-5, p.z) - realSurface.height(p.x - 1e-5, p.z))).toBeLessThan(0.001);
      expect(Math.abs(realSurface.height(p.x, p.z + 1e-5) - realSurface.height(p.x, p.z - 1e-5))).toBeLessThan(0.001);
    }
    const state = createVehicle(realRoads.spawn(provenance.origin), realSurface);
    for (let step = 0; step < 240; step++) {
      stepVehicle(state, { throttle: 1, steer: 0, brake: false }, 1 / 120, realRoads, realSurface);
      expect(state.y).toBeCloseTo(realSurface.height(state.x, state.z) + ROAD_OFFSET, 7);
      expect(realRoads.fits(state)).toBe(true);
    }
    expect(state.distance).toBeGreaterThan(3);
  });
});
