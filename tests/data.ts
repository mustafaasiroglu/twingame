import { readFileSync } from 'node:fs';
import elevation from '../public/data/elevation.json';
import provenance from '../public/data/provenance.json';
import { Terrain } from '../src/geo';
import { RoadNetwork, type RoadSegment } from '../src/roads';
import { RoadSurface, type GradedSegment } from '../src/surface';

export { elevation, provenance };
export const source = new Terrain(elevation, provenance.origin);
export const segments: RoadSegment[] = JSON.parse(readFileSync('public/data/roads.json', 'utf8'));
export const network = new RoadNetwork(segments);
const bytes = readFileSync('public/data/profiles.bin');
const packed = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const profiles: GradedSegment[] = [];
for (let i = 0; i < packed.length; i += 9) profiles.push({
  a: { x: packed[i], z: packed[i + 1] }, b: { x: packed[i + 2], z: packed[i + 3] }, width: packed[i + 4],
  ha: packed[i + 5], hb: packed[i + 6], rawHa: packed[i + 7], rawHb: packed[i + 8], name: '', highway: 'profile', wayId: -1,
});
export const surface = new RoadSurface(source, network, profiles);
