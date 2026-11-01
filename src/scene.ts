import * as THREE from 'three';
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import earcut, { flatten } from 'earcut';
import { Terrain, type Point } from './geo';
import { ROAD_OFFSET, type RoadNetwork, type RoadSegment } from './roads';
import { vehicleBasis, type VehicleState } from './vehicle';
import { asphaltTextures, asphaltUV, ASPHALT_TILE_METRES } from './asphalt';
import { addCar as addDetailedCar, type Wheel } from './car';
import { RoadSurface } from './surface';
import { WorldRenderer, type WorldManifest } from './world';

export function palette(): Record<string, THREE.Color> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(['bg', 'bg-elevated', 'surface', 'surface-soft', 'border', 'border-strong', 'text', 'text-muted', 'accent', 'accent-fg', 'link', 'success']
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
  return surfaceVertices(terrain, roads, ROAD_OFFSET);
}

export function surfaceVertices(terrain: Terrain, polygons: MultiPolygon, lift: number): number[] {
  const vertices: number[] = [];
  const boxes = polygons.map(p => ({
    polygon: p,
    minX: Math.min(...p[0].map(v => v[0])), maxX: Math.max(...p[0].map(v => v[0])),
    minZ: Math.min(...p[0].map(v => v[1])), maxZ: Math.max(...p[0].map(v => v[1])),
  }));
  for (let tileRow = 0; tileRow < terrain.data.rows - 1; tileRow += 12) {
    for (let tileCol = 0; tileCol < terrain.data.cols - 1; tileCol += 12) {
      const lastCol = Math.min(tileCol + 12, terrain.data.cols - 1);
      const lastRow = Math.min(tileRow + 12, terrain.data.rows - 1);
      const min = terrain.vertex(tileCol, tileRow), max = terrain.vertex(lastCol, lastRow);
      const nearby: MultiPolygon = boxes.filter(p => p.maxX >= min.x && p.minX <= max.x && p.maxZ >= min.z && p.minZ <= max.z).map(p => p.polygon);
      if (!nearby.length) continue;
      const local = polygonClipping.intersection(nearby, [[[min.x, min.z], [max.x, min.z], [max.x, max.z], [min.x, max.z], [min.x, min.z]]]);
      if (!local.length) continue;
      for (let r = tileRow; r < lastRow; r++) for (let c = tileCol; c < lastCol; c++) {
        const a = terrain.vertex(c, r), b = terrain.vertex(c + 1, r);
        const d = terrain.vertex(c, r + 1), e = terrain.vertex(c + 1, r + 1);
        for (const tri of [[a, b, e], [a, e, d]]) {
          const ring: [number, number][] = tri.map(p => [p.x, p.z]);
          ring.push(ring[0]);
          const clipped = polygonClipping.intersection(local, [ring]);
          for (const polygon of clipped) {
            const flat = flatten(polygon);
            const indices = earcut(flat.vertices, flat.holes, 2);
            for (let i = 0; i < indices.length; i += 3) {
              // Reverse x/z polygon winding for upward-facing triangles in x/y/z.
              for (const index of [indices[i], indices[i + 2], indices[i + 1]]) {
                const x = flat.vertices[index * 2], z = flat.vertices[index * 2 + 1];
                vertices.push(x, terrain.height(x, z) + lift, z);
              }
            }
          }
        }
      }
    }
  }
  return vertices;
}

export const MARKING_LIFT = 0.025;
export function roadMarkings(roads: RoadNetwork): { polygons: MultiPolygon; centers: Point[] } {
  const polygons: Polygon[] = [], centers: Point[] = [];
  const counts = new Map<string, { point: Point; count: number }>();
  for (const segment of roads.segments) for (const point of [segment.a, segment.b]) {
    const key = `${point.x.toFixed(3)},${point.z.toFixed(3)}`;
    counts.set(key, { point, count: (counts.get(key)?.count || 0) + 1 });
  }
  const junctions = [...counts.values()].filter(p => p.count >= 3);
  const phases = new Map<number, number>();
  for (const segment of roads.segments) {
    const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
    const length = Math.hypot(dx, dz);
    const phase = segment.phase ?? phases.get(segment.wayId) ?? 0;
    phases.set(segment.wayId, phase + length);
    if (segment.width < 7.5) continue;
    for (let dash = Math.floor(phase / 12) * 12; dash < phase + length; dash += 12) {
      const start = Math.max(0, dash - phase), end = Math.min(length, dash + 4 - phase);
      if (end <= start) continue;
      const center = { x: segment.a.x + dx * (start + end) / 2 / length, z: segment.a.z + dz * (start + end) / 2 / length };
      if (junctions.some(j => Math.hypot(j.point.x - center.x, j.point.z - center.z) < 10)) continue;
      const a = { x: segment.a.x + dx * start / length, z: segment.a.z + dz * start / length };
      const b = { x: segment.a.x + dx * end / length, z: segment.a.z + dz * end / length };
      const nx = -dz / length * 0.09, nz = dx / length * 0.09;
      polygons.push([[[a.x + nx, a.z + nz], [a.x - nx, a.z - nz], [b.x - nx, b.z - nz], [b.x + nx, b.z + nz], [a.x + nx, a.z + nz]]]);
      centers.push(center);
    }
  }
  return { polygons: polygons.length ? polygonClipping.union(polygons[0], ...polygons.slice(1)) : [], centers };
}

const geometryFrom = (vertices: number[]) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
};
export function resolutionRatio(current: number, maximum: number, frameMs: number): number {
  if (frameMs > 45) return Math.max(0.5, current * 0.8);
  if (frameMs < 22) return Math.min(maximum, current + 0.05);
  return current;
}

export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.75, 2200);
  readonly car = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly wheels: Wheel[] = [];
  readonly roadMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly markingCenters: Point[] = [];
  private readonly bodyMatrix = new THREE.Matrix4();
  private readonly axisRight = new THREE.Vector3();
  private readonly axisUp = new THREE.Vector3();
  private readonly axisForward = new THREE.Vector3();
  private roadMaxEdge = 0;
  private readonly world?: WorldRenderer;
  onError?: (error: unknown) => void;
  private cameraReady = false;
  private frameMs = 16;
  private qualityElapsed = 0;
  private maximumPixelRatio = Math.min(window.devicePixelRatio, 1.75);
  private readonly look = new THREE.Vector3();
  overview = false;

  constructor(container: HTMLElement, readonly terrain: Terrain, readonly roads: RoadNetwork, manifest?: WorldManifest) {
    const p = palette();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.maximumPixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.domElement.setAttribute('aria-label', 'Ihlamur Kasrı ve Beşiktaş üç boyutlu sürüş alanı');
    container.append(this.renderer.domElement);
    this.scene.background = p.bg;
    this.scene.fog = new THREE.Fog(p.bg, 380, 1600);
    const illumination = document.documentElement.dataset.theme === 'dark' ? p.text : p.surface;
    this.scene.add(new THREE.HemisphereLight(illumination, p['border'], 1.0));
    const sun = new THREE.DirectionalLight(illumination, 1.8);
    sun.position.set(-200, 400, 150);
    this.scene.add(sun);

    const base = p['text-muted'].clone().lerp(p['bg-elevated'], document.documentElement.dataset.theme === 'dark' ? 0.5 : 0);
    const textures = asphaltTextures(base, this.renderer.capabilities.getMaxAnisotropy());
    this.roadMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
      map: textures.map, roughnessMap: textures.grain, bumpMap: textures.grain, bumpScale: 0.018, roughness: 0.98,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    if (terrain instanceof RoadSurface && manifest) {
      this.world = new WorldRenderer(this.scene, terrain, roads, p, { polygons: roadPolygons, vertices: surfaceVertices, markings: roadMarkings }, manifest, this.roadMesh.material);
      this.world.onError = error => { if (this.onError) this.onError(error); else console.error('Terrain worker failed:', error); };
    } else {
      this.addTerrain(p);
      const vertices = roadVertices(terrain, roadPolygons(roads.segments));
      this.roadMesh.geometry = geometryFrom(vertices);
      this.roadMesh.geometry.setAttribute('uv', new THREE.BufferAttribute(asphaltUV(vertices), 2));
      for (let i = 0; i < vertices.length; i += 9) for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) this.roadMaxEdge = Math.max(this.roadMaxEdge, Math.hypot(vertices[i + a] - vertices[i + b], vertices[i + a + 2] - vertices[i + b + 2]));
      this.roadMesh.renderOrder = 1; this.scene.add(this.roadMesh); this.addMarkings(p);
    }
    this.wheels.push(...addDetailedCar(this.body, p));
    this.car.add(this.body);
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
    const marks = roadMarkings(this.roads);
    this.markingCenters.push(...marks.centers);
    const white = document.documentElement.dataset.theme === 'dark' ? p.text : p.surface;
    const paint = new THREE.Mesh(geometryFrom(surfaceVertices(this.terrain, marks.polygons, ROAD_OFFSET + MARKING_LIFT)), new THREE.MeshBasicMaterial({
      color: white, toneMapped: false, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    paint.renderOrder = 2;
    this.scene.add(paint);
  }

  private addTerrain(p: Record<string, THREE.Color>): void {
    const terrain = this.terrain, { cols, rows, values } = terrain.data;
    const positions = new Float32Array(cols * rows * 3), colors = new Float32Array(positions.length);
    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6), contours: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, v = terrain.vertex(c, r), height = values[i];
      positions.set([v.x, height, v.z], i * 3);
      const color = height < 0.5 ? p.border.clone().lerp(p.link, 0.12)
        : p.border.clone().lerp(p['border-strong'], Math.min(0.65, 0.15 + height / 140));
      colors.set([color.r, color.g, color.b], i * 3);
    }
    let next = 0;
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      indices.set([a, e, b, a, d, e], next); next += 6;
      for (const tri of [[a, e, b], [a, d, e]]) {
        const min = Math.min(...tri.map(i => values[i])), max = Math.max(...tri.map(i => values[i]));
        for (let level = Math.max(10, Math.ceil(min / 10) * 10); level <= max; level += 10) {
          const crossings: number[] = [];
          for (let j = 0; j < 3; j++) {
            const u = tri[j], v = tri[(j + 1) % 3];
            if ((values[u] < level) === (values[v] < level)) continue;
            const t = (level - values[u]) / (values[v] - values[u]);
            crossings.push(positions[u * 3] + (positions[v * 3] - positions[u * 3]) * t, level + 0.035, positions[u * 3 + 2] + (positions[v * 3 + 2] - positions[u * 3 + 2]) * t);
          }
          if (crossings.length === 6) contours.push(...crossings);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1)); g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(contours, 3));
    this.scene.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: p['border-strong'], transparent: true, opacity: 0.32 })));
  }

  render(state: VehicleState, dt: number): void {
    if (this.world?.needs(state)) this.world.update(state).catch(error => {
      if (this.onError) this.onError(error); else console.error('OSM world could not update:', error);
    });
    this.car.position.set(state.x, state.y, state.z);
    this.car.rotation.y = state.heading;
    const basis = vehicleBasis(state.pitch, state.roll);
    this.bodyMatrix.makeBasis(this.axisRight.set(...basis.right), this.axisUp.set(...basis.up), this.axisForward.set(...basis.forward));
    this.body.quaternion.setFromRotationMatrix(this.bodyMatrix);
    for (const wheel of this.wheels) {
      wheel.pivot.rotation.y = wheel.front ? state.steering * 0.35 : 0;
      wheel.spin.rotation.x += state.speed * dt / 0.34;
    }
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
  trackFrame(milliseconds: number): void {
    this.frameMs += (Math.min(250, milliseconds) - this.frameMs) * 0.05;
    this.qualityElapsed += milliseconds;
    if (this.qualityElapsed < 1500) return;
    this.qualityElapsed = 0;
    const current = this.renderer.getPixelRatio(), next = resolutionRatio(current, this.maximumPixelRatio, this.frameMs);
    if (Math.abs(next - current) > 0.001) this.renderer.setPixelRatio(next);
  }
  async prepare(point: Point): Promise<void> { await this.world?.update(point); }

  readRenderState(state: VehicleState) {
    const rotation = this.body.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
    const world = this.world?.diagnostics();
    const marks = (world?.markings || this.markingCenters).flatMap(point => {
      const ahead = (point.x - state.x) * Math.sin(state.heading) + (point.z - state.z) * Math.cos(state.heading);
      if (ahead < 5 || ahead > 70) return [];
      const projected = new THREE.Vector3(point.x, this.terrain.height(point.x, point.z) + ROAD_OFFSET + MARKING_LIFT, point.z).project(this.camera);
      if (Math.abs(projected.x) > 0.9 || Math.abs(projected.y) > 0.9 || Math.abs(projected.z) > 1) return [];
      return [{ x: (projected.x + 1) / 2, y: (1 - projected.y) / 2, ahead }];
    });
    return {
      roadTriangles: world?.roadTriangles ?? this.roadMesh.geometry.getAttribute('position').count / 3, roadMaxEdge: world?.roadMaxEdge ?? this.roadMaxEdge,
      asphaltTextured: this.roadMesh.material.map !== null, asphaltTileMetres: ASPHALT_TILE_METRES,
      forward: forward.toArray(), right: right.toArray(), carParts: this.body.children.length,
      frontWheelSteer: this.wheels.find(w => w.front)?.pivot.rotation.y, forwardMarkings: marks,
      activeChunks: world?.activeChunks, activeBuildings: world?.activeBuildings, activeTrees: world?.activeTrees, activeMappedTrees: world?.activeMappedTrees,
      activeInferredTrees: world?.activeInferredTrees, sidewalksMapped: world?.sidewalksMapped, sidewalksInferred: world?.sidewalksInferred, palaceBuildings: world?.palaceBuildings,
      drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
      chunkCenter: world?.chunkCenter, loadingChunks: world?.loadingChunks,
      chunkError: world?.chunkError,
      focusTilesLoaded: world?.focusTilesLoaded,
      pixelRatio: this.renderer.getPixelRatio(),
      targetChunkCenter: this.world ? `${Math.floor((state.x - this.terrain.min.x) / 192)}_${Math.floor((state.z - this.terrain.min.z) / 192)}` : undefined,
    };
  }
}
