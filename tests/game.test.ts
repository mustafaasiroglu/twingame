import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import osm from '../public/data/osm-source.json';
import elevation from '../public/data/elevation.json';
import provenance from '../public/data/provenance.json';
import { clipSegment, closestPoint, project, Terrain, unproject } from '../src/geo';
import { extractRoads, isDrivable, RoadNetwork, ROAD_OFFSET, roadWidth, type OsmData, type OsmWay, type RoadSegment } from '../src/roads';
import { createVehicle, Input, stepVehicle } from '../src/vehicle';
import { roadPolygons, roadVertices } from '../src/scene';

const terrain = new Terrain(elevation, provenance.origin);
const segments = extractRoads(osm as OsmData, provenance.bounds, provenance.origin);
const network = new RoadNetwork(segments);
const flat = new Terrain({ cols: 2, rows: 2, west: -0.01, north: 0.01, stepLon: 0.02, stepLat: 0.02, values: [0, 0, 0, 0] }, { lon: 0, lat: 0 });
const segment = (ax: number, az: number, bx: number, bz: number, width = 8): RoadSegment => ({
  a: { x: ax, z: az }, b: { x: bx, z: bz }, width, name: 'Test road', wayId: 1, highway: 'residential',
});
const straight = new RoadNetwork([segment(0, -200, 0, 200)]);
const advance = (state: ReturnType<typeof createVehicle>, controls: { throttle: number; steer: number; brake: boolean }, seconds: number, roads = straight) => {
  for (let i = 0; i < seconds * 120; i++) stepVehicle(state, controls, 1 / 120, roads, flat);
};
const neutral = { throttle: 0, steer: 0, brake: false };

describe('real geographic data', () => {
  it('contains bounded non-flat real samples, source date and attribution', () => {
    expect(elevation.values).toHaveLength(elevation.cols * elevation.rows);
    expect(Math.max(...elevation.values) - Math.min(...elevation.values)).toBeGreaterThan(30);
    expect(provenance.roads.rawSha256).toHaveLength(64);
    expect(createHash('sha256').update(readFileSync('public/data/osm-source.json')).digest('hex')).toBe(provenance.roads.rawSha256);
    expect(provenance.elevation.product).toContain('DSM');
    expect(provenance.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('honors source RasterPixelIsPoint alignment with no half-pixel shift', () => {
    expect(provenance.elevation.geoKeys.GTRasterTypeGeoKey).toBe(2);
    expect(elevation.west).toBeCloseTo(28 + provenance.elevation.pixelWindow[0] / 3600, 10);
    expect(elevation.north).toBeCloseTo(42 - provenance.elevation.pixelWindow[1] / 3600, 10);
  });
  it('projects east to +x, north to -z and roundtrips coordinates', () => {
    const p = project(28.9777, 41.0148, provenance.origin);
    expect(p.x).toBeGreaterThan(0); expect(p.z).toBeLessThan(0);
    expect(unproject(p, provenance.origin).lon).toBeCloseTo(28.9777, 10);
    expect(unproject(p, provenance.origin).lat).toBeCloseTo(41.0148, 10);
  });
  it('interpolates all sample centres exactly and refuses missing/out-of-bounds data', () => {
    for (let r = 0; r < elevation.rows; r++) for (let c = 0; c < elevation.cols; c++) {
      const p = terrain.vertex(c, r);
      expect(terrain.height(p.x, p.z)).toBeCloseTo(elevation.values[r * elevation.cols + c], 6);
    }
    expect(() => terrain.height(1e6, 1e6)).toThrow('outside');
    expect(() => new Terrain({ ...elevation, values: [NaN] }, provenance.origin)).toThrow('Invalid');
  });
  it('uses the rendered triangle diagonal rather than a different bilinear collider', () => {
    const t = new Terrain({ cols: 2, rows: 2, west: 0, north: 0, stepLon: 0.01, stepLat: 0.01, values: [0, 10, 20, 40] }, { lon: 0, lat: 0 });
    expect(t.height(t.dx * 0.75, t.dz * 0.25)).toBeCloseTo(15);
    expect(t.height(t.dx * 0.25, t.dz * 0.75)).toBeCloseTo(20);
  });
  it('clips crossing roads, not only nodes inside the area', () => {
    expect(clipSegment({ x: -2, z: 0 }, { x: 2, z: 0 }, { x: -1, z: -1 }, { x: 1, z: 1 })).toEqual([{ x: -1, z: 0 }, { x: 1, z: 0 }]);
    expect(clipSegment({ x: -2, z: 2 }, { x: 2, z: 2 }, { x: -1, z: -1 }, { x: 1, z: 1 })).toBeNull();
    expect(closestPoint({ x: 3, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }).distance).toBe(3);
  });
});

describe('connected drivable surfaces', () => {
  it('selects a substantial actual connected road graph around Sirkeci and Eminönü', () => {
    expect(network.totalLength).toBeGreaterThan(3000);
    expect(segments.some(s => s.name.includes('Ankara'))).toBe(true);
    for (const [lon, lat] of [[28.9777, 41.0143], [28.9711, 41.0164]]) {
      expect(network.nearest(project(lon, lat, provenance.origin)).distance).toBeLessThan(150);
    }
    const visited = new Set<number>([0]);
    let changed = true;
    while (changed) {
      changed = false;
      segments.forEach((s, i) => {
        if (visited.has(i)) return;
        if ([...visited].some(j => [segments[j].a, segments[j].b].some(p =>
          Math.hypot(s.a.x - p.x, s.a.z - p.z) < 0.001 || Math.hypot(s.b.x - p.x, s.b.z - p.z) < 0.001))) {
          visited.add(i); changed = true;
        }
      });
    }
    expect(visited.size).toBe(segments.length);
  });
  it('excludes pedestrian/private/grade-separated ways; handles width and lanes honestly', () => {
    const way = (tags: Record<string, string>): OsmWay => ({ type: 'way', id: 1, nodes: [1, 2], tags });
    const excluded: Record<string, string>[] = [{ highway: 'footway' }, { highway: 'pedestrian' }, { highway: 'primary', bridge: 'yes' }, { highway: 'secondary', tunnel: 'yes' }, { highway: 'residential', access: 'private' }];
    for (const tags of excluded) {
      expect(isDrivable(way(tags))).toBe(false);
    }
    expect(roadWidth({ highway: 'residential', width: '3 m' })).toBe(6.4);
    expect(roadWidth({ highway: 'secondary', lanes: '3' })).toBeCloseTo(9.6);
  });
  it('keeps every road capsule and safe spawn inside elevation coverage', () => {
    for (const s of segments) for (const p of [s.a, s.b]) {
      expect(p.x - s.width / 2).toBeGreaterThan(terrain.min.x);
      expect(p.x + s.width / 2).toBeLessThan(terrain.max.x);
      expect(p.z - s.width / 2).toBeGreaterThan(terrain.min.z);
      expect(p.z + s.width / 2).toBeLessThan(terrain.max.z);
    }
    expect(network.fits(network.spawn(provenance.origin))).toBe(true);
  });
  it('leaves junction interiors open and unions visible surfaces without duplicate overlaps', () => {
    const cross = new RoadNetwork([segment(0, -20, 0, 20), segment(-20, 0, 20, 0)]);
    expect(cross.fits({ x: 2.4, z: 2.4 })).toBe(true);
    expect(cross.fits({ x: 5, z: 5 })).toBe(false);
    const union = roadPolygons(cross.segments);
    expect(union.length).toBe(1);
    expect(union[0].length).toBe(1);
  });
  it('matches all tessellated road vertices to the exact terrain/collision height', () => {
    const vertices = roadVertices(terrain, roadPolygons(segments.slice(0, 8)));
    expect(vertices.length).toBeGreaterThan(0);
    expect(vertices.length % 9).toBe(0);
    for (let i = 0; i < vertices.length; i += 3) {
      expect(vertices[i + 1]).toBeCloseTo(terrain.height(vertices[i], vertices[i + 2]) + ROAD_OFFSET, 7);
    }
    for (let i = 0; i < vertices.length; i += 9) {
      const abx = vertices[i + 3] - vertices[i], abz = vertices[i + 5] - vertices[i + 2];
      const acx = vertices[i + 6] - vertices[i], acz = vertices[i + 8] - vertices[i + 2];
      expect(abz * acx - abx * acz).toBeGreaterThanOrEqual(-1e-10);
    }
  });
});

describe('keyboard and multi-pointer controls', () => {
  it('maps arrows and WASD, cancels opposing inputs and rejects unrelated keys', () => {
    const input = new Input();
    expect(input.setKey('Escape', true)).toBe(false);
    input.setKey('ArrowUp', true); input.setKey('KeyA', true);
    expect(input.read()).toEqual({ throttle: 1, steer: 1, brake: false });
    input.setKey('KeyS', true); input.setKey('ArrowRight', true); input.setKey('Space', true);
    expect(input.read()).toEqual({ throttle: 0, steer: 0, brake: true });
    input.clear();
    expect(input.read()).toEqual(neutral);
  });
  it('does not drop keyboard or another finger when one touch is released', () => {
    const input = new Input();
    input.setKey('ArrowUp', true);
    input.setTouch('1', 'ArrowUp'); input.setTouch('2', 'ArrowLeft');
    input.setTouch('1', null);
    expect(input.read()).toEqual({ throttle: 1, steer: 1, brake: false });
    input.setKey('ArrowUp', false);
    expect(input.read().throttle).toBe(0);
    input.clear(); expect(input.read()).toEqual(neutral);
  });
});

describe('arcade vehicle', () => {
  it('accelerates forward, integrates distance and remains terrain-grounded', () => {
    const state = createVehicle({ x: 0, z: -100, heading: 0 }, flat);
    advance(state, { ...neutral, throttle: 1 }, 2);
    expect(state.z).toBeGreaterThan(-90);
    expect(state.speed).toBeGreaterThan(10);
    expect(state.distance).toBeCloseTo(state.z + 100, 5);
    expect(state.y).toBe(ROAD_OFFSET);
  });
  it('brakes before reversing; space brake is stronger than coasting', () => {
    const state = createVehicle({ x: 0, z: -100, heading: 0 }, flat);
    advance(state, { ...neutral, throttle: 1 }, 1);
    advance(state, { ...neutral, throttle: -1 }, 0.2);
    expect(state.speed).toBeGreaterThan(0);
    advance(state, { ...neutral, throttle: -1 }, 1);
    expect(state.speed).toBeLessThan(0);
    const coast = { ...state, speed: 10 }, brake = { ...state, speed: 10 };
    advance(coast, neutral, 0.3); advance(brake, { ...neutral, brake: true }, 0.3);
    expect(brake.speed).toBeLessThan(coast.speed - 4);
  });
  it('steers left forward and mirrors steering when reversing', () => {
    const forward = createVehicle({ x: 0, z: 0, heading: 0 }, flat);
    forward.speed = 2;
    advance(forward, { ...neutral, steer: 1 }, 0.2);
    expect(forward.heading).toBeGreaterThan(0); expect(forward.x).toBeGreaterThan(0);
    const reverse = createVehicle({ x: 0, z: 0, heading: 0 }, flat);
    reverse.speed = -2;
    advance(reverse, { ...neutral, steer: 1 }, 0.2);
    expect(reverse.heading).toBeLessThan(0);
  });
  it('cannot tunnel off road at top speed; rejects excessive dt', () => {
    const state = createVehicle({ x: 0, z: 0, heading: Math.PI / 2 }, flat);
    state.speed = 22;
    advance(state, { ...neutral, throttle: 1 }, 3);
    expect(straight.fits(state)).toBe(true);
    expect(state.x).toBeLessThan(3);
    expect(() => stepVehicle(state, neutral, 1, straight, flat)).toThrow('50ms');
  });
  it('drives through a real source road and matches sampled elevation each step', () => {
    const state = createVehicle(network.spawn(provenance.origin), terrain);
    for (let i = 0; i < 240; i++) {
      stepVehicle(state, { ...neutral, throttle: 1 }, 1 / 120, network, terrain);
      expect(network.fits(state)).toBe(true);
      expect(state.y).toBeCloseTo(terrain.height(state.x, state.z) + ROAD_OFFSET, 7);
    }
    expect(state.distance).toBeGreaterThan(2);
  });
});
