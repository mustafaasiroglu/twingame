import { describe, expect, it } from 'vitest';
import { network as actualRoads, surface as actualSurface } from './data';
import { closestPoint, Terrain } from '../src/geo';
import { extractRoads, RoadNetwork, VEHICLE_HALF_WIDTH, type OsmData, type RoadSegment } from '../src/roads';
import { RoadSurface } from '../src/surface';
import { createVehicle, stepVehicle } from '../src/vehicle';

const flat = new Terrain({ cols: 2, rows: 2, west: -0.01, north: 0.01, stepLon: 0.02, stepLat: 0.02, values: [0, 0, 0, 0] }, { lon: 0, lat: 0 });
const segment = (ax: number, az: number, bx: number, bz: number, width = 6.4): RoadSegment => ({
  a: { x: ax, z: az }, b: { x: bx, z: bz }, width, name: 'Handling fixture', wayId: 1, highway: 'service',
});
const straight = new RoadNetwork([segment(0, -200, 0, 200)]);
const gas = { throttle: 1, steer: 0, brake: false };
function drive(x: number, controls = gas, seconds = 1, heading = 0, roads = straight) {
  const state = createVehicle({ x, z: 0, heading }, flat);
  state.speed = 10;
  for (let i = 0; i < seconds * 120; i++) stepVehicle(state, controls, 1 / 120, roads, flat);
  return state;
}

describe('usable asphalt width and boundary handling', () => {
  it('uses the oriented body width, not a length-sized circular exclusion zone', () => {
    for (const heading of [0, Math.PI]) {
      expect(straight.fits({ x: 2.1, z: 0, heading })).toBe(true);
      expect(straight.fits({ x: 2.2, z: 0, heading })).toBe(false);
    }
    expect(straight.contains({ x: 3.1, z: 0 })).toBe(true);
    expect(straight.fits({ x: 3.1, z: 0, heading: 0 })).toBe(false);
    expect(straight.fits({ x: 1.3, z: 0, heading: Math.PI / 2 })).toBe(false);
    const diagonal = new RoadNetwork([segment(-100, -100, 100, 100)]);
    expect(diagonal.fits({ x: 2.1 / Math.sqrt(2), z: -2.1 / Math.sqrt(2), heading: Math.PI / 4 })).toBe(true);
  });
  it('has identical acceleration and coasting at the centre and just inside both asphalt edges', () => {
    for (const controls of [gas, { ...gas, throttle: 0 }]) {
      const center = drive(0, controls);
      for (const x of [-2.1, -1.9, 1.9, 2.1]) {
        const edge = drive(x, controls);
        expect(straight.fits(edge)).toBe(true);
        expect(edge.speed).toBeCloseTo(center.speed, 10);
        expect(edge.distance).toBeCloseTo(center.distance, 10);
      }
    }
    console.log('Inside asphalt speeds (m/s):', { center: drive(0).speed, nearEdge: drive(1.9).speed, coastingNearEdge: drive(1.9, { ...gas, throttle: 0 }).speed });
  });
  it('still blocks and slows actual outward impacts without tunnelling or leaving the footprint outside', () => {
    const state = drive(0, gas, 2, Math.PI / 2);
    expect(straight.fits(state)).toBe(true);
    expect(state.x).toBeLessThanOrEqual(3.2 - 2 + 1e-6);
    expect(state.speed).toBeLessThan(1);
    const outside = drive(3.4);
    expect(outside.distance).toBe(0);
    expect(outside.speed).toBeLessThan(1);
  });
  it('retains tangential motion at grazing contact instead of applying full head-on drag', () => {
    const angle = 0.15;
    const support = VEHICLE_HALF_WIDTH * Math.cos(angle) + 2 * Math.sin(angle);
    const x = 3.2 - support - 0.005;
    const grazing = drive(x, gas, 0.5, angle);
    const free = drive(0, gas, 0.5, angle);
    expect(straight.fits(grazing)).toBe(true);
    expect(grazing.speed).toBeGreaterThan(free.speed * 0.9);
    expect(grazing.distance).toBeGreaterThan(free.distance * 0.9);
  });
  it('keeps unions open at bends and mixed-width junctions, including reverse travel', () => {
    const junction = new RoadNetwork([segment(0, -200, 0, 200, 10), segment(-200, 0, 200, 0)]);
    for (const speed of [-10, 10]) {
      const state = createVehicle({ x: 2.7, z: -8, heading: 0 }, flat);
      const reference = { ...state, x: 0 };
      state.speed = reference.speed = speed;
      for (let i = 0; i < 120; i++) {
        stepVehicle(state, { ...gas, throttle: Math.sign(speed) }, 1 / 120, junction, flat);
        stepVehicle(reference, { ...gas, throttle: Math.sign(speed) }, 1 / 120, junction, flat);
        expect(junction.fits(state)).toBe(true);
      }
      expect(state.speed).toBeCloseTo(reference.speed, 10);
      expect(state.distance).toBeCloseTo(reference.distance, 10);
    }
    const bend = new RoadNetwork([segment(0, -30, 0, 0), segment(0, 0, 30, 0)]);
    expect(bend.fits({ x: 1, z: -1, heading: Math.PI / 4 })).toBe(true);
    expect(bend.fits({ x: -3, z: 3, heading: Math.PI / 4 })).toBe(false);
  });
  it('slides along the free union tangent even when a narrower crossing has the nearest centre-line', () => {
    const junction = new RoadNetwork([segment(0, -200, 0, 200, 10), segment(-200, 0, 200, 0)]);
    const state = createVehicle({ x: 3.95, z: 3.1, heading: 0 }, flat);
    state.speed = 10;
    const reference = { ...state, x: 0 };
    expect(junction.nearest(state).segment.width).toBe(6.4);
    for (let i = 0; i < 120; i++) {
      stepVehicle(state, { ...gas, steer: 1 }, 1 / 120, junction, flat);
      stepVehicle(reference, gas, 1 / 120, junction, flat);
      expect(junction.fits(state)).toBe(true);
    }
    expect(state.heading).toBe(0);
    expect(state.speed).toBeCloseTo(reference.speed, 8);
    expect(state.distance).toBeCloseTo(reference.distance, 8);
  });
  it('allows real narrow-road near-edge driving without changing source-derived contact heights', () => {
    const roads = actualRoads, surface = actualSurface;
    let checked = 0;
    for (const segment of roads.segments) {
      const length = Math.hypot(segment.b.x - segment.a.x, segment.b.z - segment.a.z);
      if (length < 50 || segment.width > 7) continue;
      const heading = Math.atan2(segment.b.x - segment.a.x, segment.b.z - segment.a.z);
      const offset = segment.width / 2 - VEHICLE_HALF_WIDTH - 0.2;
      const p = { x: (segment.a.x + segment.b.x) / 2 + Math.cos(heading) * offset, z: (segment.a.z + segment.b.z) / 2 - Math.sin(heading) * offset, heading };
      if (!roads.fits(p)) continue;
      const edge = createVehicle(p, surface), center = createVehicle({ ...p, x: p.x - Math.cos(heading) * offset, z: p.z + Math.sin(heading) * offset }, surface);
      edge.speed = center.speed = 6;
      for (let i = 0; i < 60; i++) {
        stepVehicle(edge, gas, 1 / 120, roads, surface);
        stepVehicle(center, gas, 1 / 120, roads, surface);
        expect(roads.fits(edge)).toBe(true);
        expect(edge.y).toBeCloseTo(surface.height(edge.x, edge.z) + 0.08, 8);
      }
      expect(edge.speed).toBeCloseTo(center.speed, 8);
      expect(edge.distance).toBeCloseTo(center.distance, 8);
      expect(closestPoint(p, segment.a, segment.b).distance).toBeGreaterThan(segment.width / 2 - 2.15);
      checked++;
      if (checked >= 8) break;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
