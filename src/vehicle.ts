import type { Point, Terrain } from './geo';
import { ROAD_OFFSET, type RoadNetwork } from './roads';

export interface Controls { throttle: number; steer: number; brake: boolean }
export interface VehicleState extends Point {
  heading: number; speed: number; y: number; pitch: number; roll: number;
  distance: number; steering: number;
}
const MAX_SPEED = 22;
const MAX_REVERSE = 7;

export function createVehicle(spawn: Point & { heading: number }, terrain: Terrain): VehicleState {
  return { ...spawn, ...sampleVehiclePose(spawn, spawn.heading, terrain), speed: 0, distance: 0, steering: 0 };
}

export function sampleVehiclePose(point: Point, heading: number, terrain: Terrain): { y: number; pitch: number; roll: number } {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const forward = terrain.height(point.x + fx * 1.18, point.z + fz * 1.18);
  const back = terrain.height(point.x - fx * 1.18, point.z - fz * 1.18);
  const right = terrain.height(point.x + fz * 0.86, point.z - fx * 0.86);
  const left = terrain.height(point.x - fz * 0.86, point.z + fx * 0.86);
  return {
    y: terrain.height(point.x, point.z) + ROAD_OFFSET,
    pitch: Math.atan2(forward - back, 2.36),
    roll: Math.atan2(right - left, 1.72),
  };
}

type Vector3 = [number, number, number];
export function vehicleBasis(pitch: number, roll: number): { right: Vector3; up: Vector3; forward: Vector3 } {
  const normalize = (v: Vector3): Vector3 => { const length = Math.hypot(...v); return [v[0] / length, v[1] / length, v[2] / length]; };
  const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const gx = Math.tan(roll), gz = Math.tan(pitch);
  const forward = normalize([0, gz, 1]), up = normalize([-gx, 1, -gz]);
  return { forward, up, right: normalize(cross(up, forward)) };
}

export function stepVehicle(state: VehicleState, input: Controls, dt: number, roads: RoadNetwork, terrain: Terrain): void {
  if (!Number.isFinite(dt) || dt < 0 || dt > 0.05) throw new Error('Simulation requires a finite 0–50ms step');
  const throttle = Math.max(-1, Math.min(1, input.throttle));
  const steer = Math.max(-1, Math.min(1, input.steer));
  state.steering = steer;
  const acceleration = throttle !== 0 && Math.sign(throttle) !== Math.sign(state.speed) && Math.abs(state.speed) > 0.5
    ? throttle * 16 : throttle * 7.5;
  const drag = input.brake ? 22 : throttle === 0 ? 2.0 : 0.25 + 0.005 * state.speed ** 2;
  state.speed += acceleration * dt;
  state.speed = Math.sign(state.speed) * Math.max(0, Math.abs(state.speed) - drag * dt);
  state.speed = Math.max(-MAX_REVERSE, Math.min(MAX_SPEED, state.speed));
  // Positive heading points toward +x from +z. Left is +heading, including reverse steering.
  const turn = steer * Math.min(1.4, Math.abs(state.speed) * 0.23) * Math.sign(state.speed) * dt;
  state.heading += turn;
  const distance = state.speed * dt;
  const next = { x: state.x + Math.sin(state.heading) * distance, z: state.z + Math.cos(state.heading) * distance };
  if (roads.fits(next)) {
    state.x = next.x; state.z = next.z; state.distance += Math.abs(distance);
  } else {
    // Resolve impact along the road tangent; never snap to another road across a gap.
    const nearest = roads.nearest(state);
    const dx = nearest.segment.b.x - nearest.segment.a.x;
    const dz = nearest.segment.b.z - nearest.segment.a.z;
    const length = Math.hypot(dx, dz);
    const tangentDistance = (Math.sin(state.heading) * dx + Math.cos(state.heading) * dz) / length * distance;
    const slide = { x: state.x + dx / length * tangentDistance, z: state.z + dz / length * tangentDistance };
    if (roads.fits(slide)) {
      state.distance += Math.hypot(slide.x - state.x, slide.z - state.z);
      state.x = slide.x; state.z = slide.z;
    }
    state.speed *= Math.exp(-14 * dt);
  }
  const pose = sampleVehiclePose(state, state.heading, terrain);
  state.y = pose.y;
  const blend = 1 - Math.exp(-12 * dt);
  state.pitch += (pose.pitch - state.pitch) * blend;
  state.roll += (pose.roll - state.roll) * blend;
}

const drivingKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space']);
export class Input {
  private keys = new Set<string>();
  private touches = new Map<string, string>();
  setKey(code: string, down: boolean): boolean {
    if (!drivingKeys.has(code)) return false;
    if (down) this.keys.add(code); else this.keys.delete(code);
    return true;
  }
  setTouch(pointer: string, code: string | null): void {
    if (code) this.touches.set(pointer, code); else this.touches.delete(pointer);
  }
  clear(): void { this.keys.clear(); this.touches.clear(); }
  read(): Controls {
    const down = (code: string) => this.keys.has(code) || [...this.touches.values()].includes(code);
    return {
      throttle: Number(down('ArrowUp') || down('KeyW')) - Number(down('ArrowDown') || down('KeyS')),
      steer: Number(down('ArrowLeft') || down('KeyA')) - Number(down('ArrowRight') || down('KeyD')),
      brake: down('Space'),
    };
  }
}
