import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Terrain, type ElevationData, type Origin, type Bounds } from '../src/geo';
import { extractRoads, RoadNetwork, type OsmData } from '../src/roads';
import { engineerProfile } from '../src/surface';
import { extractFeatures, inferTrees, box, type AreaFeature, type PathFeature, type TreeFeature } from '../src/features';

const directory = path.join('public', 'data');
const read = async (name: string) => JSON.parse(await readFile(path.join(directory, `${name}.json`), 'utf8'));
const provenance: { origin: Origin; bounds: Bounds; region: { radiusMetres: number }; roads: { rawSha256: string } } = await read('provenance');
const osm: OsmData = await read('osm-source'), elevation: ElevationData = await read('elevation');
const source = new Terrain(elevation, provenance.origin);
console.log('Preparing connected roads, shared graded profiles and OSM detail tiles offline…');
const roads = new RoadNetwork(extractRoads(osm, provenance.bounds, provenance.origin, provenance.region.radiusMetres));
const displayRoads = extractRoads(osm, provenance.bounds, provenance.origin, provenance.region.radiusMetres, false);
const profiles = engineerProfile(source, roads);
const packed = new Float64Array(profiles.length * 9);
profiles.forEach((p, i) => packed.set([p.a.x, p.a.z, p.b.x, p.b.z, p.width, p.ha, p.hb, p.rawHa, p.rawHb], i * 9));
const features = extractFeatures(osm, provenance.origin, provenance.region.radiusMetres);
features.trees = inferTrees(features, roads);
const tiles = new Map<string, { areas: AreaFeature[]; paths: PathFeature[]; trees: TreeFeature[] }>();
const tile = (x: number, z: number) => `${Math.floor((x - source.min.x) / 192)}_${Math.floor((z - source.min.z) / 192)}`;
const obtain = (key: string) => { const existing = tiles.get(key); if (existing) return existing; const value: { areas: AreaFeature[]; paths: PathFeature[]; trees: TreeFeature[] } = { areas: [], paths: [], trees: [] }; tiles.set(key, value); return value; };
for (const area of features.areas) {
  for (let c = Math.floor((area.min.x - source.min.x) / 192); c <= Math.floor((area.max.x - source.min.x) / 192); c++) {
    for (let r = Math.floor((area.min.z - source.min.z) / 192); r <= Math.floor((area.max.z - source.min.z) / 192); r++) obtain(`${c}_${r}`).areas.push(area);
  }
}
for (const pathFeature of features.paths) {
  const bounds = box(pathFeature.points);
  if (bounds.max.x < source.min.x || bounds.min.x > source.max.x || bounds.max.z < source.min.z || bounds.min.z > source.max.z) continue;
  for (let c = Math.max(0, Math.floor((bounds.min.x - source.min.x) / 192)); c <= Math.floor((Math.min(bounds.max.x, source.max.x) - source.min.x) / 192); c++) {
    for (let r = Math.max(0, Math.floor((bounds.min.z - source.min.z) / 192)); r <= Math.floor((Math.min(bounds.max.z, source.max.z) - source.min.z) / 192); r++) obtain(`${c}_${r}`).paths.push(pathFeature);
  }
}
for (const tree of features.trees) obtain(tile(tree.x, tree.z)).trees.push(tree);
await mkdir(path.join(directory, 'tiles'), { recursive: true });
for (const name of await readdir(path.join(directory, 'tiles'))) {
  if (/^\d+_\d+\.json$/.test(name) && !tiles.has(name.slice(0, -5))) await unlink(path.join(directory, 'tiles', name));
}
for (const [key, value] of tiles) await writeFile(path.join(directory, 'tiles', `${key}.json`), JSON.stringify(value) + '\n');
const stats = {
  buildings: features.areas.filter(a => a.kind === 'building').length, buildingParts: features.areas.filter(a => a.kind === 'part').length,
  declaredHeights: features.areas.filter(a => ['building', 'part'].includes(a.kind) && a.heightSource === 'height').length,
  levelHeights: features.areas.filter(a => ['building', 'part'].includes(a.kind) && a.heightSource === 'levels').length,
  defaultHeights: features.areas.filter(a => ['building', 'part'].includes(a.kind) && a.heightSource === 'default').length,
  greenAreas: features.areas.filter(a => a.kind === 'green').length, waterAreas: features.areas.filter(a => a.kind === 'water').length,
  paths: features.paths.length, mappedTrees: features.trees.filter(t => t.source === 'node').length,
  rowTrees: features.trees.filter(t => t.source === 'row').length, inferredTrees: features.trees.filter(t => t.source === 'inferred').length,
  omittedIncomplete: features.incomplete.length,
};
const palaceIds = ['way/312484207', 'way/312484208'];
const focusTiles = [...tiles].filter(([, data]) => data.areas.some(area => palaceIds.includes(area.id))).map(([key]) => key);
await Promise.all([
  writeFile(path.join(directory, 'roads.json'), JSON.stringify(roads.segments) + '\n'),
  writeFile(path.join(directory, 'display-roads.json'), JSON.stringify(displayRoads) + '\n'),
  writeFile(path.join(directory, 'profiles.bin'), new Uint8Array(packed.buffer)),
  writeFile(path.join(directory, 'world.json'), JSON.stringify({ sourceSha256: provenance.roads.rawSha256, tileMetres: 192, tiles: [...tiles.keys()], stats, incomplete: features.incomplete, palaceIds, focusTiles, profilesFormat: 'Float64 LE, nine values: ax,az,bx,bz,width,ha,hb,rawHa,rawHb', sourceOnly: true }, null, 2) + '\n'),
]);
console.log(JSON.stringify({ roads: roads.segments.length, roadKm: roads.totalLength / 1000, profiles: profiles.length, tiles: tiles.size, ...stats }, null, 2));
