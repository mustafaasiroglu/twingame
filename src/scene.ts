import * as THREE from 'three';
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import earcut, { flatten } from 'earcut';
import { Terrain, type Point } from './geo';
import { ROAD_OFFSET, type RoadNetwork, type RoadSegment } from './roads';
import type { VehicleState } from './vehicle';

export function palette(): Record<string, THREE.Color> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(['bg', 'bg-elevated', 'surface', 'surface-soft', 'border', 'border-strong', 'text', 'text-muted', 'accent', 'accent-fg', 'link']
    .map(name => [name, new THREE.Color(style.getPropertyValue(`--cp-${name}`).trim())]));
}

function capsule(s: RoadSegment): Polygon {
  const heading = Math.atan2(s.b.z - s.a.z, s.b.x - s.a.x);
  const ring: [number, number][] = [];
  for (const [point, offset] of [[s.b, -Math.PI / 2], [s.a, Math.PI / 2]] as const) {
    for (let i = 0; i <= 16; i++) {
      const angle = heading + offset + i * Math.PI / 16;
      ring.push([point.x + Math.cos(angle) * s.width / 2, point.z + Math.sin(angle) * s.width / 2]);
    }
  }
  ring.push(ring[0]);
  return [ring];
}

export function roadPolygons(segments: RoadSegment[]): MultiPolygon {
  let parts: MultiPolygon[] = [];
  for (let i = 0; i < segments.length; i += 32) {
    const chunk = segments.slice(i, i + 32).map(capsule);
    parts.push(polygonClipping.union(chunk[0], ...chunk.slice(1)));
  }
  while (parts.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      next.push(parts[i + 1] ? polygonClipping.union(parts[i], parts[i + 1]) : parts[i]);
    }
    parts = next;
  }
  return parts[0];
}

export function roadVertices(terrain: Terrain, roads: MultiPolygon): number[] {
  const vertices: number[] = [];
  const boxes = roads.map(p => ({
    polygon: p,
    minX: Math.min(...p[0].map(v => v[0])), maxX: Math.max(...p[0].map(v => v[0])),
    minZ: Math.min(...p[0].map(v => v[1])), maxZ: Math.max(...p[0].map(v => v[1])),
  }));
  for (let r = 0; r < terrain.data.rows - 1; r++) {
    for (let c = 0; c < terrain.data.cols - 1; c++) {
      const a = terrain.vertex(c, r), b = terrain.vertex(c + 1, r);
      const d = terrain.vertex(c, r + 1), e = terrain.vertex(c + 1, r + 1);
      const nearby: MultiPolygon = boxes.filter(p => p.maxX >= a.x && p.minX <= e.x && p.maxZ >= a.z && p.minZ <= e.z).map(p => p.polygon);
      if (!nearby.length) continue;
      for (const tri of [[a, b, e], [a, e, d]]) {
        const ring: [number, number][] = tri.map(p => [p.x, p.z]);
        ring.push(ring[0]);
        const clipped = polygonClipping.intersection(nearby, [ring]);
        for (const polygon of clipped) {
          const flat = flatten(polygon);
          const indices = earcut(flat.vertices, flat.holes, 2);
          for (let i = 0; i < indices.length; i += 3) {
            // Reverse x/z polygon winding for upward-facing triangles in x/y/z.
            for (const index of [indices[i], indices[i + 2], indices[i + 1]]) {
              const x = flat.vertices[index * 2], z = flat.vertices[index * 2 + 1];
              vertices.push(x, terrain.height(x, z) + ROAD_OFFSET, z);
            }
          }
        }
      }
    }
  }
  return vertices;
}

const geometryFrom = (vertices: number[]) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
};

export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.75, 2200);
  readonly car = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private cameraReady = false;
  private readonly look = new THREE.Vector3();
  overview = false;

  constructor(container: HTMLElement, readonly terrain: Terrain, readonly roads: RoadNetwork) {
    const p = palette();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.domElement.setAttribute('aria-label', 'Eminönü–Sirkeci üç boyutlu sürüş alanı');
    container.append(this.renderer.domElement);
    this.scene.background = p.bg;
    this.scene.fog = new THREE.Fog(p.bg, 380, 1600);
    const illumination = document.documentElement.dataset.theme === 'dark' ? p.text : p.surface;
    this.scene.add(new THREE.HemisphereLight(illumination, p['border'], 1.0));
    const sun = new THREE.DirectionalLight(illumination, 1.8);
    sun.position.set(-200, 400, 150);
    this.scene.add(sun);

    const positions: number[] = [], colors: number[] = [], contours: number[] = [];
    for (let r = 0; r < terrain.data.rows - 1; r++) {
      for (let c = 0; c < terrain.data.cols - 1; c++) {
        const a = terrain.vertex(c, r), b = terrain.vertex(c + 1, r);
        const d = terrain.vertex(c, r + 1), e = terrain.vertex(c + 1, r + 1);
        for (const tri of [[a, e, b], [a, d, e]]) {
          const points = tri.map(v => new THREE.Vector3(v.x, terrain.height(v.x, v.z), v.z));
          for (const v of points) {
            positions.push(v.x, v.y, v.z);
            const color = v.y < 0.5 ? p['border'].clone().lerp(p.link, 0.12)
              : p['border'].clone().lerp(p['border-strong'], Math.min(0.65, 0.15 + v.y / 140));
            colors.push(color.r, color.g, color.b);
          }
          for (let level = 10; level <= 80; level += 10) {
            const crossings: THREE.Vector3[] = [];
            for (let j = 0; j < 3; j++) {
              const u = points[j], v = points[(j + 1) % 3];
              if ((u.y < level) !== (v.y < level)) crossings.push(u.clone().lerp(v, (level - u.y) / (v.y - u.y)));
            }
            if (crossings.length === 2) for (const v of crossings) contours.push(v.x, v.y + 0.035, v.z);
          }
        }
      }
    }
    const groundGeometry = geometryFrom(positions);
    groundGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.scene.add(new THREE.Mesh(groundGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })));
    const contourGeometry = new THREE.BufferGeometry();
    contourGeometry.setAttribute('position', new THREE.Float32BufferAttribute(contours, 3));
    this.scene.add(new THREE.LineSegments(contourGeometry, new THREE.LineBasicMaterial({ color: p['border-strong'], transparent: true, opacity: 0.32 })));
    this.scene.add(new THREE.Mesh(
      geometryFrom(roadVertices(terrain, roadPolygons(roads.segments))),
      new THREE.MeshStandardMaterial({ color: p['text-muted'], roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    ));
    this.addMarkings(p);
    this.addCar(p);
    this.scene.add(this.car);
    window.addEventListener('resize', () => {
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
    });
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
  }

  private addMarkings(p: Record<string, THREE.Color>): void {
    const vertices: number[] = [];
    const junctions = new Map<string, { p: Point; count: number }>();
    for (const s of this.roads.segments) for (const v of [s.a, s.b]) {
      const k = `${v.x.toFixed(3)},${v.z.toFixed(3)}`;
      const existing = junctions.get(k);
      junctions.set(k, { p: v, count: (existing?.count || 0) + 1 });
    }
    const busy = [...junctions.values()].filter(v => v.count >= 3);
    for (const s of this.roads.segments) {
      if (s.width < 7.5) continue;
      const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
      const length = Math.hypot(dx, dz);
      for (let dist = 2; dist + 4 < length; dist += 12) {
        const center = { x: s.a.x + dx * (dist + 2) / length, z: s.a.z + dz * (dist + 2) / length };
        if (busy.some(v => Math.hypot(v.p.x - center.x, v.p.z - center.z) < 10)) continue;
        for (let j = 0; j < 4; j++) {
          const at = (dist + j) / length, end = (dist + j + 1) / length;
          const a = { x: s.a.x + dx * at, z: s.a.z + dz * at };
          const b = { x: s.a.x + dx * end, z: s.a.z + dz * end };
          const pts = [
            { x: a.x - dz / length * 0.12, z: a.z + dx / length * 0.12 },
            { x: a.x + dz / length * 0.12, z: a.z - dx / length * 0.12 },
            { x: b.x + dz / length * 0.12, z: b.z - dx / length * 0.12 },
            { x: b.x - dz / length * 0.12, z: b.z + dx / length * 0.12 },
          ];
          for (const index of [0, 2, 1, 0, 3, 2]) {
            const v = pts[index];
            vertices.push(v.x, this.terrain.height(v.x, v.z) + ROAD_OFFSET + 0.025, v.z);
          }
        }
      }
    }
    this.scene.add(new THREE.Mesh(geometryFrom(vertices), new THREE.MeshBasicMaterial({ color: p['surface'], side: THREE.DoubleSide })));
  }

  private addCar(p: Record<string, THREE.Color>): void {
    const paint = new THREE.MeshStandardMaterial({ color: p.accent, roughness: 0.35, metalness: 0.15 });
    const glass = new THREE.MeshStandardMaterial({ color: p['bg-elevated'], roughness: 0.25, metalness: 0.4 });
    const trim = new THREE.MeshStandardMaterial({ color: p['border-strong'], roughness: 0.8 });
    const box = (w: number, h: number, l: number, y: number, z: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), material);
      mesh.position.set(0, y, z);
      this.body.add(mesh);
    };
    box(1.65, 0.48, 3.4, 0.66, 0, paint);
    box(1.4, 0.5, 1.6, 1.12, -0.15, glass);
    box(1.46, 0.1, 1.64, 1.42, -0.15, paint);
    box(1.7, 0.18, 0.15, 0.48, -1.72, trim);
    box(1.7, 0.18, 0.15, 0.48, 1.72, trim);
    const headlight = new THREE.MeshBasicMaterial({ color: p.surface });
    for (const x of [-0.56, 0.56]) {
      const light = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.16, 0.03), headlight);
      light.position.set(x, 0.7, 1.715);
      this.body.add(light);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.03), new THREE.MeshBasicMaterial({ color: p.accent }));
      tail.position.set(x, 0.7, -1.715);
      this.body.add(tail);
    }
    for (const x of [-0.85, 0.85]) for (const z of [-1.1, 1.1]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.22, 16), new THREE.MeshStandardMaterial({ color: p['bg-elevated'] }));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.36, z);
      this.wheels.push(wheel);
      this.body.add(wheel);
    }
    this.car.add(this.body);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 32),
      new THREE.MeshBasicMaterial({ color: p['bg-elevated'], transparent: true, opacity: 0.22, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.scale.set(0.7, 1.3, 1);
    this.car.add(shadow);
  }

  render(state: VehicleState, dt: number): void {
    this.car.position.set(state.x, state.y, state.z);
    this.car.rotation.y = state.heading;
    this.body.rotation.x = -state.pitch;
    this.body.rotation.z = state.roll;
    for (const wheel of this.wheels) wheel.rotation.x += state.speed * dt / 0.36;
    const fx = Math.sin(state.heading), fz = Math.cos(state.heading);
    const compact = window.innerWidth <= 700;
    const chaseDistance = compact ? 17 : 15;
    const target = this.overview
      ? new THREE.Vector3(state.x - 15, state.y + 380, state.z + 80)
      : new THREE.Vector3(state.x - fx * chaseDistance, state.y + (compact ? 9 : 8), state.z - fz * chaseDistance);
    // Prevent the chase camera from entering a nearby hill on steep DSM slopes.
    if (!this.overview && target.x >= this.terrain.min.x && target.x <= this.terrain.max.x &&
        target.z >= this.terrain.min.z && target.z <= this.terrain.max.z) {
      target.y = Math.max(target.y, this.terrain.height(target.x, target.z) + 4);
    }
    const lookAhead = this.overview ? 0 : compact ? 2 : 8;
    const look = new THREE.Vector3(state.x + fx * lookAhead, state.y + 1.1, state.z + fz * lookAhead);
    const blend = this.cameraReady ? 1 - Math.exp(-5 * dt) : 1;
    this.camera.position.lerp(target, blend);
    this.look.lerp(look, blend);
    this.camera.lookAt(this.look);
    this.cameraReady = true;
    this.renderer.render(this.scene, this.camera);
  }
  resetCamera(): void { this.cameraReady = false; }
}
