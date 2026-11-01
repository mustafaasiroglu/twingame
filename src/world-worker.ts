import * as THREE from 'three';
import { Terrain, type ElevationData, type Origin } from './geo';
import { RoadNetwork, type RoadSegment } from './roads';
import { RoadSurface, type GradedSegment } from './surface';
import { WorldRenderer, type WorldManifest, type DetailTile } from './world';
import { roadPolygons, roadMarkings, surfaceVertices } from './scene';

interface Init { type: 'init'; manifest: WorldManifest; palette: Record<string, [number, number, number]>; dark: boolean }
interface Request { type: 'chunk'; id: number; col: number; row: number; fine: boolean; detail: DetailTile }
async function json<T>(name: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${name}.json`);
  if (!response.ok) throw new Error(`Terrain worker ${name}: HTTP ${response.status}`);
  return response.json();
}
async function initialize(message: Init): Promise<WorldRenderer> {
  const [roads, display, elevation, provenance, response] = await Promise.all([
    json<RoadSegment[]>('roads'), json<RoadSegment[]>('display-roads'), json<ElevationData>('elevation'),
    json<{ origin: Origin; roads: { rawSha256: string } }>('provenance'), fetch(`${import.meta.env.BASE_URL}data/profiles.bin`),
  ]);
  if (!response.ok) throw new Error(`Terrain worker profiles: HTTP ${response.status}`);
  if (provenance.roads.rawSha256 !== message.manifest.sourceSha256) throw new Error('Terrain worker source does not match provenance');
  const packed = new Float64Array(await response.arrayBuffer());
  if (!packed.length || packed.length % 9 || packed.some(v => !Number.isFinite(v))) throw new Error('Terrain worker profiles are invalid');
  const profiles: GradedSegment[] = [];
  for (let i = 0; i < packed.length; i += 9) profiles.push({ a: { x: packed[i], z: packed[i + 1] }, b: { x: packed[i + 2], z: packed[i + 3] }, width: packed[i + 4], ha: packed[i + 5], hb: packed[i + 6], rawHa: packed[i + 7], rawHb: packed[i + 8], name: '', highway: 'profile', wayId: -1 });
  const surface = new RoadSurface(new Terrain(elevation, provenance.origin), new RoadNetwork(roads), profiles);
  const palette = Object.fromEntries(Object.entries(message.palette).map(([name, rgb]) => [name, new THREE.Color(...rgb)]));
  return new WorldRenderer(new THREE.Scene(), surface, new RoadNetwork(display), palette, { polygons: roadPolygons, vertices: surfaceVertices, markings: roadMarkings }, message.manifest, new THREE.MeshStandardMaterial(), false, message.dark);
}
let ready: Promise<WorldRenderer> | undefined;
self.onmessage = async (event: MessageEvent<Init | Request>) => {
  const message = event.data;
  if (message.type === 'init') {
    ready = initialize(message);
    ready.catch(error => self.postMessage({ error: `Terrain worker initialization: ${error instanceof Error ? error.message : String(error)}` }));
    return;
  }
  try {
    if (!ready) throw new Error('Terrain worker was not initialized');
    const world = await ready, chunk = world.pack(message.col, message.row, message.fine, message.detail);
    const transfer: ArrayBuffer[] = [];
    for (const mesh of chunk.meshes) {
      for (const array of Object.values(mesh.attributes)) transfer.push(array.buffer);
      if (mesh.index) transfer.push(mesh.index.buffer);
      if (mesh.matrices) transfer.push(mesh.matrices.buffer);
    }
    self.postMessage({ id: message.id, chunk }, { transfer });
  } catch (error) {
    self.postMessage({ id: message.id, error: `Terrain tile ${message.col}_${message.row}: ${error instanceof Error ? error.message : String(error)}` });
  }
};
