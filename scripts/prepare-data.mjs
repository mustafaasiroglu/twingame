import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import parseOSM from 'osm-pbf-parser';
import { fromUrl } from 'geotiff';

const directory = path.join('public', 'data'), cache = path.join('data-cache', 'Istanbul.osm.pbf');
const lookupUrl = 'https://nominatim.openstreetmap.org/search?q=Ihlamur%20Kasr%C4%B1%20Istanbul&format=jsonv2&limit=5';
const pbfUrl = 'https://download.bbbike.org/osm/bbbike/Istanbul/Istanbul.osm.pbf';
const radiusMetres = 5000;
const headers = { 'User-Agent': 'twingame-geographic-preparation/0.2' };
await mkdir(directory, { recursive: true });
await mkdir(path.dirname(cache), { recursive: true });
const cached = !process.argv.includes('--refresh-roads');
let osm, previous, lookup, distributionLastModified, pbfSha256;
try {
  previous = JSON.parse(await readFile(path.join(directory, 'provenance.json'), 'utf8'));
  if (cached && previous.region?.radiusMetres === radiusMetres && previous.region?.osmId === 312484207) {
    osm = JSON.parse(await readFile(path.join(directory, 'osm-source.json'), 'utf8'));
    lookup = previous.region.lookupResult;
    distributionLastModified = previous.roads.distributionLastModified;
    pbfSha256 = previous.roads.regionalPbfSha256;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!lookup) {
  const response = await fetch(lookupUrl, { headers, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`OSM place lookup HTTP ${response.status}`);
  const results = await response.json();
  lookup = results.find(r => r.osm_type === 'way' && r.osm_id === 312484207 && r.name.includes('Merasim'));
  if (!lookup) throw new Error('The actual OSM Ihlamur Kasrı palace lookup could not be resolved');
}
const origin = { lon: Number(lookup.lon), lat: Number(lookup.lat) };
const latRadius = radiusMetres / 6371008.8 * 180 / Math.PI;
const lonRadius = latRadius / Math.cos(origin.lat * Math.PI / 180);
const bounds = { west: origin.lon - lonRadius, east: origin.lon + lonRadius, south: origin.lat - latRadius, north: origin.lat + latRadius };
if (!osm) {
  // A licensed regional extract is a preparation-only alternative when public Overpass workers are unavailable.
  if (!cached || !(await stat(cache).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) {
    const response = await fetch(pbfUrl, { headers, signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Public regional PBF HTTP ${response.status}`);
    distributionLastModified = response.headers.get('last-modified');
    if (Number(response.headers.get('content-length')) > 100_000_000) throw new Error('Regional preparation download exceeds the 100 MB safety bound');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(cache));
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(cache)) hash.update(chunk);
  pbfSha256 = hash.digest('hex');
  const nodes = new Map(), ways = new Map(), relations = new Map();
  const relevant = tags => Boolean(tags.highway || tags.building || tags['building:part'] ||
    ['tree', 'tree_row', 'wood', 'water', 'coastline', 'scrub'].includes(tags.natural) ||
    ['park', 'garden', 'nature_reserve', 'recreation_ground', 'pitch'].includes(tags.leisure) ||
    ['forest', 'grass', 'meadow', 'village_green', 'recreation_ground'].includes(tags.landuse) || tags.waterway);
  const cleanTags = tags => Object.fromEntries(Object.entries(tags).filter(([key]) =>
    /^(name(:.*)?|highway|area|width|lanes|access|motor_vehicle|motorcar|bridge|tunnel|layer|building(:.*)?|height|min_height|roof:.*|natural|leisure|landuse|landcover|surface|water|waterway|leaf_type|leaf_cycle|species|genus|diameter_crown|circumference|sidewalk(:.*)?|footway|type)$/.test(key)));
  async function scan(visit) {
    await pipeline(createReadStream(cache), parseOSM(), new Writable({
      objectMode: true,
      write(batch, encoding, done) {
        try { for (const item of batch) visit(item); done(); } catch (error) { done(error); }
      },
    }));
  }
  console.log('Filtering public Istanbul PBF to the bounded Ihlamur region…');
  await scan(item => {
    if (item.type === 'node' && item.lon >= bounds.west && item.lon <= bounds.east && item.lat >= bounds.south && item.lat <= bounds.north) {
      nodes.set(item.id, { type: 'node', id: item.id, lon: item.lon, lat: item.lat, tags: cleanTags(item.tags) });
    } else if (item.type === 'way' && relevant(item.tags) && item.refs.some(id => nodes.has(id))) {
      ways.set(item.id, { type: 'way', id: item.id, nodes: item.refs, tags: cleanTags(item.tags) });
    } else if (item.type === 'relation' && relevant(item.tags)) {
      relations.set(item.id, { type: 'relation', id: item.id, tags: cleanTags(item.tags), members: item.members.map(m => ({ type: m.type, ref: m.id, role: m.role })) });
    }
  });
  const selectedRelations = [...relations.values()].filter(r => r.members.some(m => m.type === 'way' && ways.has(m.ref)));
  const missingWays = new Set(selectedRelations.flatMap(r => r.members.filter(m => m.type === 'way' && !ways.has(m.ref)).map(m => m.ref)));
  const requiredNodes = new Set([...ways.values()].flatMap(w => w.nodes));
  await scan(item => {
    if (item.type === 'node' && requiredNodes.has(item.id) && !nodes.has(item.id)) nodes.set(item.id, { type: 'node', id: item.id, lon: item.lon, lat: item.lat, tags: cleanTags(item.tags) });
    if (item.type === 'way' && missingWays.has(item.id)) {
      ways.set(item.id, { type: 'way', id: item.id, nodes: item.refs, tags: cleanTags(item.tags) });
      for (const id of item.refs) requiredNodes.add(id);
    }
  });
  await scan(item => {
    if (item.type === 'node' && requiredNodes.has(item.id) && !nodes.has(item.id)) nodes.set(item.id, { type: 'node', id: item.id, lon: item.lon, lat: item.lat, tags: cleanTags(item.tags) });
  });
  const retained = [...nodes.values()].filter(n => requiredNodes.has(n.id) || ['tree'].includes(n.tags.natural));
  osm = { version: 0.6, generator: 'twingame bounded BBBike OSM extract; contributor identity metadata removed', elements: [...retained, ...ways.values(), ...selectedRelations] };
  if (!ways.has(312484207)) throw new Error('Actual Ihlamur palace footprint is missing from the geographic extract');
}
const retrievedAt = new Date().toISOString();
const sampleStep = 1 / 3600;
const west = Math.floor(bounds.west / sampleStep) * sampleStep - sampleStep;
const north = Math.ceil(bounds.north / sampleStep) * sampleStep + sampleStep;
const cols = Math.ceil((bounds.east - west) / sampleStep) + 2, rows = Math.ceil((north - bounds.south) / sampleStep) + 2;
const values = Array(cols * rows).fill(null), sources = [];
for (let tileLon = Math.floor(west); tileLon <= Math.floor(west + (cols - 1) * sampleStep); tileLon++) {
  const tile = `Copernicus_DSM_COG_10_N41_00_E${String(tileLon).padStart(3, '0')}_00_DEM`;
  const sourceUrl = `https://copernicus-dem-30m.s3.amazonaws.com/${tile}/${tile}.tif`;
  const image = await (await fromUrl(sourceUrl)).getImage();
  const [ox, oy] = image.getOrigin(), [rx, ry] = image.getResolution(), geoKeys = image.getGeoKeys();
  if (geoKeys.GTRasterTypeGeoKey !== 2 || Math.abs(rx - sampleStep) > 1e-12 || Math.abs(ry + sampleStep) > 1e-12) throw new Error('Unexpected source point registration or spacing');
  const first = Math.max(0, Math.ceil((tileLon - west) / sampleStep - 1e-7));
  const last = Math.min(cols - 1, Math.floor((tileLon + 1 - sampleStep - west) / sampleStep + 1e-7));
  const minCol = Math.round((west + first * sampleStep - ox) / rx), minRow = Math.round((north - oy) / ry);
  const window = [minCol, minRow, minCol + last - first + 1, minRow + rows];
  const raster = (await image.readRasters({ window, samples: [0] }))[0], noData = image.getGDALNoData();
  for (let r = 0; r < rows; r++) for (let c = first; c <= last; c++) {
    const v = raster[r * (last - first + 1) + c - first];
    if (!Number.isFinite(v) || v === noData) throw new Error('Missing real source elevation; no flat fallback');
    values[r * cols + c] = v;
  }
  sources.push({ sourceUrl, geoKeys, pixelWindow: window, tiepoint: [ox, oy], noData });
}
if (values.some(v => v === null)) throw new Error('Elevation tile seam or crop has missing samples');
const elevation = { cols, rows, west, north, stepLon: sampleStep, stepLat: sampleStep, values };
const raw = JSON.stringify(osm);
const min = values.reduce((a, b) => Math.min(a, b), Infinity), max = values.reduce((a, b) => Math.max(a, b), -Infinity);
const provenance = {
  bounds, origin, retrievedAt,
  region: { name: 'Ihlamur Kasrı – Beşiktaş', radiusMetres, interpretation: '5 km radius, not diameter; circular playable/detail region within the persisted bounding rectangle', osmType: lookup.osm_type, osmId: lookup.osm_id, lookupUrl, lookupResult: lookup },
  roads: { provider: 'OpenStreetMap contributors via public BBBike Istanbul extract', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', licenseUrl: 'https://www.openstreetmap.org/copyright', endpoint: pbfUrl, regionalBoundary: 'https://download.bbbike.org/osm/bbbike/Istanbul/Istanbul.poly', regionalPbfSha256: pbfSha256, distributionLastModified: distributionLastModified || previous?.roads.distributionLastModified, osmTimestamp: null, timestampMeaning: 'Publisher file modification is not an OSM database base timestamp or feature survey date', query: 'Preparation-only bounding-box filter: road/building/green/path/tree/water ways and relevant relation members; full referenced nodes retained; runtime clipped to 5 km circle', retrievedAt: cached && previous?.region ? previous.roads.retrievedAt : retrievedAt, rawSha256: createHash('sha256').update(raw + '\n').digest('hex') },
  elevation: { ...previous.elevation, sourceUrl: sources[0].sourceUrl, sources, geoKeys: sources[0].geoKeys, pixelWindow: sources[0].pixelWindow, pixelCoordinates: 'RasterPixelIsPoint in both tiles; no half-pixel shift; shared 1/3600 degree lattice across E028/E029 seam', min, max },
};
await Promise.all([
  writeFile(path.join(directory, 'osm-source.json'), raw + '\n'),
  writeFile(path.join(directory, 'elevation.json'), JSON.stringify(elevation) + '\n'),
  writeFile(path.join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n'),
]);
console.log(`Saved actual OSM ${lookup.osm_type}/${lookup.osm_id} center ${origin.lat},${origin.lon}; ${osm.elements.length} bounded elements, ${cols}×${rows} real DSM samples, ${min.toFixed(1)}–${max.toFixed(1)} m.`);
