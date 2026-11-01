import * as THREE from 'three';
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import earcut, { flatten } from 'earcut';
import { RoadNetwork, ROAD_OFFSET, type RoadSegment } from './roads';
import { RoadSurface, ROAD_GRID_METRES } from './surface';
import { type Terrain, type Point } from './geo';
import { SpatialIndex, pathSegments, sidewalks, type AreaFeature, type PathFeature, type TreeFeature } from './features';
import { asphaltUV } from './asphalt';

export interface WorldManifest {
  sourceSha256: string; tileMetres: number; tiles: string[]; stats: Record<string, number>; incomplete: string[]; palaceIds: string[];
  focusTiles?: string[];
}
export interface DetailTile { areas: AreaFeature[]; paths: PathFeature[]; trees: TreeFeature[] }
export interface PackedChunk {
  data: Record<string, unknown>;
  meshes: { attributes: Record<string, Float32Array<ArrayBuffer>>; index?: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>; material: string; order: number; matrices?: Float32Array<ArrayBuffer>; count?: number }[];
}
interface MeshTools {
  polygons: (segments: RoadSegment[]) => MultiPolygon;
  vertices: (terrain: Terrain, polygons: MultiPolygon, lift: number) => number[];
  markings: (roads: RoadNetwork) => { polygons: MultiPolygon; centers: Point[] };
}
export function surfaceEdge(a: number[], b: number[], surface: Terrain): Point[] {
  const dx = surface instanceof RoadSurface ? ROAD_GRID_METRES : surface.dx, dz = surface instanceof RoadSurface ? ROAD_GRID_METRES : surface.dz;
  const ax = (a[0] - surface.min.x) / dx, az = (a[1] - surface.min.z) / dz;
  const bx = (b[0] - surface.min.x) / dx, bz = (b[1] - surface.min.z) / dz;
  const stops = new Set([0, 1]);
  for (const [start, end] of [[ax, bx], [az, bz], [az - ax, bz - bx]]) {
    if (Math.abs(end - start) < 1e-10) continue;
    for (let k = Math.ceil(Math.min(start, end)); k < Math.max(start, end); k++) {
      const t = (k - start) / (end - start);
      if (t > 1e-10 && t < 1 - 1e-10) stops.add(t);
    }
  }
  return [...stops].sort((a, b) => a - b).map(t => ({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t }));
}
export function buildingVertices(polygons: MultiPolygon, surface: Terrain, height: number, minHeight = 0): { vertices: number[]; siteHeight: number; roofHeight: number; groundMin: number } {
  const vertices: number[] = [], heights = polygons.flatMap(p => p.flatMap(r => r.map(v => surface.height(v[0], v[1]))));
  const siteHeight = heights.reduce((a, b) => Math.max(a, b), -Infinity), groundMin = heights.reduce((a, b) => Math.min(a, b), Infinity), roofHeight = siteHeight + height;
  for (const polygon of polygons) {
    const data = flatten(polygon), indices = earcut(data.vertices, data.holes, 2);
    for (let i = 0; i < indices.length; i += 3) for (const index of [indices[i], indices[i + 2], indices[i + 1]]) vertices.push(data.vertices[index * 2], roofHeight, data.vertices[index * 2 + 1]);
    for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
      const points = surfaceEdge(ring[i - 1], ring[i], surface);
      for (let step = 1; step < points.length; step++) {
        const { x: x1, z: z1 } = points[step - 1], { x: x2, z: z2 } = points[step];
        const y1 = surface.height(x1, z1) + minHeight - 0.15, y2 = surface.height(x2, z2) + minHeight - 0.15;
        vertices.push(x1, y1, z1, x2, y2, z2, x2, roofHeight, z2, x1, y1, z1, x2, roofHeight, z2, x1, roofHeight, z1);
      }
    }
  }
  return { vertices, siteHeight, roofHeight, groundMin };
}
export function sidewalkPolygons(segments: RoadSegment[], tools: Pick<MeshTools, 'polygons'>): MultiPolygon {
  if (!segments.length) return [];
  const roads = new RoadNetwork(segments), sides = sidewalks(roads).segments;
  if (!sides.length) return [];
  // Parallel sidewalk/asphalt boundaries share a millimetre precision lattice.
  // Otherwise round-off from separate capsule unions can break ring assembly.
  const snap = (polygons: MultiPolygon): MultiPolygon => polygons.map(p => p.map(r => r.map(([x, z]) => [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000])));
  return polygonClipping.difference(snap(tools.polygons(sides)), snap(tools.polygons(segments)));
}
const geometry = (vertices: number[]) => {
  const result = new THREE.BufferGeometry(); result.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); result.computeVertexNormals(); return result;
};
export class WorldRenderer {
  private readonly chunks = new Map<string, THREE.Group>();
  private readonly roadIndex: SpatialIndex<RoadSegment & { min: Point; max: Point }>;
  private readonly available: Set<string>;
  private center = '';
  pending = false;
  failed = false;
  onError?: (error: Error) => void;
  private readonly leaf = new THREE.SphereGeometry(1, 7, 5);
  private readonly trunk = new THREE.CylinderGeometry(0.12, 0.2, 1, 6);
  private readonly terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  private readonly buildingMaterial: THREE.MeshStandardMaterial;
  private readonly greenMaterial: THREE.MeshStandardMaterial;
  private readonly waterMaterial: THREE.MeshStandardMaterial;
  private readonly walkwayMaterial: THREE.MeshStandardMaterial;
  private readonly paintMaterial: THREE.MeshBasicMaterial;
  private readonly leafMaterials: Record<TreeFeature['source'], THREE.MeshStandardMaterial>;
  private readonly trunkMaterial: THREE.MeshStandardMaterial;
  private worker?: Worker;
  private sequence = 0;
  private requests = new Map<number, { resolve: (chunk: THREE.Group) => void; reject: (error: Error) => void }>();
  private materials: Record<string, THREE.Material>;
  constructor(private scene: THREE.Scene, private surface: RoadSurface, private roads: RoadNetwork, private palette: Record<string, THREE.Color>, private tools: MeshTools, readonly manifest: WorldManifest, private asphalt: THREE.MeshStandardMaterial, threaded = true, dark = document.documentElement.dataset.theme === 'dark') {
    this.available = new Set(manifest.tiles);
    this.roadIndex = new SpatialIndex(roads.segments.map(s => ({ ...s, min: { x: Math.min(s.a.x, s.b.x) - s.width, z: Math.min(s.a.z, s.b.z) - s.width }, max: { x: Math.max(s.a.x, s.b.x) + s.width, z: Math.max(s.a.z, s.b.z) + s.width } })));
    this.buildingMaterial = new THREE.MeshStandardMaterial({ color: palette['surface-soft'], roughness: 0.9, side: THREE.DoubleSide });
    this.greenMaterial = new THREE.MeshStandardMaterial({ color: palette.success.clone().lerp(palette.border, 0.5), roughness: 1 });
    this.waterMaterial = new THREE.MeshStandardMaterial({ color: palette.link.clone().lerp(palette.border, 0.5), roughness: 0.5 });
    this.walkwayMaterial = new THREE.MeshStandardMaterial({ color: palette['surface-soft'], roughness: 1 });
    this.trunkMaterial = new THREE.MeshStandardMaterial({ color: palette['border-strong'], roughness: 1 });
    this.leafMaterials = {
      node: new THREE.MeshStandardMaterial({ color: palette.success.clone().lerp(palette['text-muted'], 0.3), roughness: 1 }),
      row: new THREE.MeshStandardMaterial({ color: palette.success.clone().lerp(palette.border, 0.4), roughness: 1 }),
      inferred: new THREE.MeshStandardMaterial({ color: palette.success.clone().lerp(palette.border, 0.55), roughness: 1 }),
    };
    this.paintMaterial = new THREE.MeshBasicMaterial({ color: dark ? palette.text : palette.surface, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.materials = { terrain: this.terrainMaterial, building: this.buildingMaterial, green: this.greenMaterial, water: this.waterMaterial, walkway: this.walkwayMaterial, paint: this.paintMaterial, asphalt, trunk: this.trunkMaterial, node: this.leafMaterials.node, row: this.leafMaterials.row, inferred: this.leafMaterials.inferred };
    for (const [name, material] of Object.entries(this.materials)) material.name = name;
    if (threaded && typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' });
      const fail = (message: string) => {
        this.failed = true;
        for (const request of this.requests.values()) request.reject(new Error(message));
        this.requests.clear();
        this.onError?.(new Error(message));
      };
      this.worker.addEventListener('error', event => fail(`Terrain worker: ${event.message}`));
      this.worker.addEventListener('message', (event: MessageEvent<{ id?: number; error?: string; chunk?: PackedChunk }>) => {
        const { id, error, chunk } = event.data;
        if (id === undefined) { if (error) fail(error); return; }
        const request = this.requests.get(id); if (!request) return;
        this.requests.delete(id);
        if (error || !chunk) request.reject(new Error(error || 'Empty terrain worker output'));
        else {
          try { request.resolve(this.unpack(chunk)); }
          catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))); }
        }
      });
      this.worker.postMessage({ type: 'init', manifest, dark, palette: Object.fromEntries(Object.entries(palette).map(([name, color]) => [name, color.toArray()])) });
    }
  }
  private unpack(data: PackedChunk): THREE.Group {
    const chunk = new THREE.Group(); chunk.userData = data.data;
    for (const packed of data.meshes) {
      const g = new THREE.BufferGeometry();
      for (const [name, array] of Object.entries(packed.attributes)) g.setAttribute(name, new THREE.BufferAttribute(array, name === 'uv' ? 2 : 3));
      if (packed.index) g.setIndex(new THREE.BufferAttribute(packed.index, 1));
      const material = this.materials[packed.material];
      if (!material) throw new Error(`Unknown terrain material: ${packed.material}`);
      const mesh = packed.matrices ? new THREE.InstancedMesh(g, material, packed.count!) : new THREE.Mesh(g, material);
      if (mesh instanceof THREE.InstancedMesh && packed.matrices) { mesh.instanceMatrix.array.set(packed.matrices); mesh.instanceMatrix.needsUpdate = true; }
      mesh.renderOrder = packed.order; chunk.add(mesh);
    }
    return chunk;
  }
  pack(col: number, row: number, fine: boolean, detail: DetailTile): PackedChunk {
    const chunk = this.build(col, row, fine, detail), meshes: PackedChunk['meshes'] = [];
    for (const object of chunk.children) {
      if (!(object instanceof THREE.Mesh)) continue;
      const attributes: Record<string, Float32Array<ArrayBuffer>> = {};
      if (Array.isArray(object.material)) throw new Error('Chunk mesh must have one named material');
      for (const name of Object.keys(object.geometry.attributes)) attributes[name] = new Float32Array(object.geometry.getAttribute(name).array);
      const index = object.geometry.index;
      meshes.push({ attributes, index: index ? (index.array instanceof Uint32Array ? new Uint32Array(index.array) : new Uint16Array(index.array)) : undefined,
        material: object.material.name, order: object.renderOrder,
        matrices: object instanceof THREE.InstancedMesh ? new Float32Array(object.instanceMatrix.array) : undefined,
        count: object instanceof THREE.InstancedMesh ? object.count : undefined });
      if (!(object instanceof THREE.InstancedMesh)) object.geometry.dispose();
    }
    return { data: chunk.userData, meshes };
  }
  private async generate(col: number, row: number, fine: boolean, detail: DetailTile): Promise<THREE.Group> {
    if (!this.worker) return this.build(col, row, fine, detail);
    if (this.failed) throw new Error('Terrain worker is unavailable');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'chunk', id, col, row, fine, detail });
    });
  }
  needs(p: Point): boolean { return !this.pending && !this.failed && this.center !== this.key(p); }
  private key(p: Point): string { return `${Math.floor((p.x - this.surface.min.x) / 192)}_${Math.floor((p.z - this.surface.min.z) / 192)}`; }
  async update(p: Point): Promise<void> {
    if (this.pending || this.failed || this.center === this.key(p)) return;
    this.pending = true;
    const center = this.key(p), [c, r] = center.split('_').map(Number), wanted = new Set<string>();
    const plans: { key: string; col: number; row: number; fine: boolean }[] = [];
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      const col = c + dx, row = r + dz, fine = (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) || Boolean(this.manifest.focusTiles?.includes(`${col}_${row}`));
      if (col < 0 || row < 0 || this.surface.min.x + col * 192 >= this.surface.max.x - 3 || this.surface.min.z + row * 192 >= this.surface.max.z - 3) continue;
      const key = `${fine ? 'f' : 'c'}${col}_${row}`; wanted.add(key);
      if (!this.chunks.has(key)) plans.push({ key, col, row, fine });
    }
    try {
      const details = await Promise.all(plans.map(async plan => {
        const id = `${plan.col}_${plan.row}`;
        if (!plan.fine || !this.available.has(id)) return { areas: [], paths: [], trees: [] } satisfies DetailTile;
        const response = await fetch(`${import.meta.env.BASE_URL}data/tiles/${id}.json`);
        if (!response.ok) throw new Error(`OSM detail tile ${id}: HTTP ${response.status}`);
        const data: DetailTile = await response.json();
        if (!Array.isArray(data.areas) || !Array.isArray(data.paths) || !Array.isArray(data.trees)) throw new Error(`Invalid OSM detail tile ${id}`);
        return data;
      }));
      // Inner tiles first; rendering/collision use their identical 3 m lattice.
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]; if (!plan.fine) continue;
        this.install(plan.key, await this.generate(plan.col, plan.row, true, details[i]));
      }
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]; if (plan.fine) continue;
        this.install(plan.key, await this.generate(plan.col, plan.row, false, details[i]));
        if (i % 12 === 0) await new Promise(resolve => requestAnimationFrame(resolve));
      }
      for (const [key, chunk] of this.chunks) if (!wanted.has(key)) { this.dispose(chunk); this.chunks.delete(key); }
      this.center = center;
    } catch (error) { this.failed = true; throw error; }
    finally { this.pending = false; }
  }
  private install(key: string, chunk: THREE.Group) {
    const opposite = `${key[0] === 'f' ? 'c' : 'f'}${key.slice(1)}`, old = this.chunks.get(opposite);
    if (old) { this.dispose(old); this.chunks.delete(opposite); }
    this.chunks.set(key, chunk); this.scene.add(chunk);
  }
  private dispose(chunk: THREE.Group) {
    this.scene.remove(chunk);
    chunk.traverse(object => { if (object instanceof THREE.Mesh && (this.worker || !(object instanceof THREE.InstancedMesh))) object.geometry.dispose(); });
  }
  private build(col: number, row: number, fine: boolean, data: DetailTile): THREE.Group {
    const partial = this.surface.min.x + (col + 1) * 192 > this.surface.max.x || this.surface.min.z + (row + 1) * 192 > this.surface.max.z;
    const tile = this.surface.tile(col, row, fine || partial ? 1 : 8), chunk = new THREE.Group();
    const { cols, rows } = tile.data, positions: number[] = [], colors: number[] = [], indices: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const p = tile.vertex(c, r), y = tile.data.values[r * cols + c], color = this.palette.border.clone().lerp(this.palette['border-strong'], Math.min(0.5, Math.max(0, y) / 250));
      positions.push(p.x, y, p.z); colors.push(color.r, color.g, color.b);
      if (r < rows - 1 && c < cols - 1) { const a = r * cols + c; indices.push(a, a + cols + 1, a + 1, a, a + cols, a + cols + 1); }
    }
    const ground = geometry(positions); ground.setIndex(indices); ground.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); ground.computeVertexNormals();
    chunk.add(new THREE.Mesh(ground, this.terrainMaterial));
    chunk.userData = { buildings: [], trees: data.trees, markings: [], roadTriangles: 0, roadMaxEdge: 0, sidewalksMapped: 0, sidewalksInferred: 0 };
    if (!fine) return chunk;
    const rectangle: Polygon = [[[tile.min.x, tile.min.z], [tile.max.x, tile.min.z], [tile.max.x, tile.max.z], [tile.min.x, tile.max.z], [tile.min.x, tile.min.z]]];
    const segments = this.roadIndex.box(tile.min, tile.max), asphalt = segments.length ? this.tools.polygons(segments) : [];
    const addSurface = (polys: MultiPolygon, lift: number, material: THREE.Material, order = 0) => {
      if (!polys.length) return null;
      const vertices = this.tools.vertices(tile, polys, lift); if (!vertices.length) return null;
      const mesh = new THREE.Mesh(geometry(vertices), material); mesh.renderOrder = order; chunk.add(mesh); return mesh;
    };
    const road = addSurface(asphalt, ROAD_OFFSET, this.asphalt, 1);
    if (road) {
      const vertices = [...road.geometry.getAttribute('position').array]; road.geometry.setAttribute('uv', new THREE.BufferAttribute(asphaltUV(vertices), 2));
      chunk.userData.roadTriangles = vertices.length / 9;
      for (let i = 0; i < vertices.length; i += 9) for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) chunk.userData.roadMaxEdge = Math.max(chunk.userData.roadMaxEdge, Math.hypot(vertices[i + a] - vertices[i + b], vertices[i + a + 2] - vertices[i + b + 2]));
      const network = new RoadNetwork(segments), marks = this.tools.markings(network);
      addSurface(marks.polygons, ROAD_OFFSET + 0.025, this.paintMaterial, 2);
      chunk.userData.markings = marks.centers.filter(p => p.x >= tile.min.x && p.x < tile.max.x && p.z >= tile.min.z && p.z < tile.max.z);
      const sides = sidewalks(network);
      chunk.userData.sidewalksMapped = sides.mapped; chunk.userData.sidewalksInferred = sides.inferred;
      const curb = sidewalkPolygons(segments, this.tools), mesh = addSurface(curb, ROAD_OFFSET + 0.12, this.walkwayMaterial);
      if (mesh) {
        const clipped = polygonClipping.intersection(curb, rectangle), walls: number[] = [];
        for (const poly of clipped) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
          const points = surfaceEdge(ring[i - 1], ring[i], tile);
          for (let j = 1; j < points.length; j++) {
            const a = points[j - 1], b = points[j], ya = this.surface.height(a.x, a.z) + ROAD_OFFSET, yb = this.surface.height(b.x, b.z) + ROAD_OFFSET;
            walls.push(a.x, ya, a.z, b.x, yb, b.z, b.x, yb + 0.12, b.z, a.x, ya, a.z, b.x, yb + 0.12, b.z, a.x, ya + 0.12, a.z);
          }
        }
        chunk.add(new THREE.Mesh(geometry(walls), this.walkwayMaterial));
      }
    }
    for (const area of data.areas) {
      if (area.kind === 'building' || area.kind === 'part') continue;
      const clipped = polygonClipping.intersection(area.polygons, rectangle);
      addSurface(clipped, area.kind === 'paved' ? 0.055 : 0.02, area.kind === 'water' ? this.waterMaterial : area.kind === 'green' ? this.greenMaterial : this.walkwayMaterial);
    }
    const paths = pathSegments(data.paths).filter(s => Math.max(s.a.x, s.b.x) >= tile.min.x && Math.min(s.a.x, s.b.x) <= tile.max.x && Math.max(s.a.z, s.b.z) >= tile.min.z && Math.min(s.a.z, s.b.z) <= tile.max.z);
    if (paths.length) addSurface(polygonClipping.difference(this.tools.polygons(paths), asphalt), 0.06, this.walkwayMaterial);
    const parts = data.areas.filter(a => a.kind === 'part' && a.minHeight === 0);
    const buildingPositions: number[] = [];
    for (const area of data.areas) {
      if (!['building', 'part'].includes(area.kind)) continue;
      let polys = polygonClipping.intersection(area.polygons, rectangle);
      if (asphalt.length) polys = polygonClipping.difference(polys, asphalt);
      if (area.kind === 'building') for (const part of parts) {
        if (part.min.x <= area.max.x && part.max.x >= area.min.x && part.min.z <= area.max.z && part.max.z >= area.min.z) polys = polygonClipping.difference(polys, part.polygons);
      }
      if (!polys.length) continue;
      // Stable whole-footprint roof datum across tiles; the bottom is terrain-draped.
      const whole = buildingVertices(area.polygons, this.surface, area.height, area.minHeight);
      const localMaximum = Math.max(...polys.flatMap(p => p.flatMap(r => r.map(v => this.surface.height(v[0], v[1])))));
      const local = buildingVertices(polys, this.surface, whole.roofHeight - localMaximum, area.minHeight);
      for (const vertex of local.vertices) buildingPositions.push(vertex);
      chunk.userData.buildings.push({ id: area.id, name: area.tags.name, height: area.height, heightSource: area.heightSource, siteHeight: whole.siteHeight, roofHeight: whole.roofHeight, groundMin: whole.groundMin });
    }
    if (buildingPositions.length) chunk.add(new THREE.Mesh(geometry(buildingPositions), this.buildingMaterial));
    const transform = new THREE.Object3D();
    for (const source of ['node', 'row', 'inferred'] as const) {
      const trees = data.trees.filter(t => t.source === source); if (!trees.length) continue;
      const trunks = new THREE.InstancedMesh(this.trunk, this.trunkMaterial, trees.length), leaves = new THREE.InstancedMesh(this.leaf, this.leafMaterials[source], trees.length);
      trees.forEach((tree, i) => {
        const ground = this.surface.height(tree.x, tree.z);
        transform.position.set(tree.x, ground + tree.height * 0.25, tree.z); transform.scale.set(1, tree.height * 0.5, 1); transform.updateMatrix(); trunks.setMatrixAt(i, transform.matrix);
        transform.position.set(tree.x, ground + tree.height * 0.7, tree.z); transform.scale.set(2.2, tree.height * 0.35, 2.2); transform.updateMatrix(); leaves.setMatrixAt(i, transform.matrix);
      });
      trunks.instanceMatrix.needsUpdate = true; leaves.instanceMatrix.needsUpdate = true; chunk.add(trunks, leaves);
    }
    return chunk;
  }
  diagnostics() {
    const buildings = new Map<string, Record<string, string | number>>(), trees: TreeFeature[] = [], markings: Point[] = [];
    let roadTriangles = 0, roadMaxEdge = 0, mapped = 0, inferred = 0;
    for (const chunk of this.chunks.values()) {
      chunk.userData.buildings.forEach((b: Record<string, string | number>) => buildings.set(String(b.id), b));
      trees.push(...chunk.userData.trees); markings.push(...chunk.userData.markings);
      roadTriangles += chunk.userData.roadTriangles; roadMaxEdge = Math.max(roadMaxEdge, chunk.userData.roadMaxEdge);
      mapped += chunk.userData.sidewalksMapped; inferred += chunk.userData.sidewalksInferred;
    }
    return { chunkCenter: this.center, loadingChunks: this.pending, chunkError: this.failed, focusTilesLoaded: this.manifest.focusTiles?.every(key => this.chunks.has(`f${key}`)), activeChunks: this.chunks.size, activeBuildings: buildings.size, activeTrees: trees.length, activeMappedTrees: trees.filter(t => t.source === 'node').length,
      activeInferredTrees: trees.filter(t => t.source === 'inferred').length, sidewalksMapped: mapped, sidewalksInferred: inferred,
      palaceBuildings: [...buildings.values()].filter(b => this.manifest.palaceIds.includes(String(b.id))), roadTriangles, roadMaxEdge, markings };
  }
}
