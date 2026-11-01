import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fromUrl } from 'geotiff';

// Only deliberately run during preparation. The game never contacts providers.
const bounds = { west: 28.9655, east: 28.9825, south: 41.0095, north: 41.0178 };
const query = `[out:json][timeout:90];(way["highway"]["area"!="yes"](${bounds.south},${bounds.west},${bounds.north},${bounds.east}););out body;>;out skel qt;`;
const tile = 'Copernicus_DSM_COG_10_N41_00_E028_00_DEM';
const elevationUrl = `https://copernicus-dem-30m.s3.amazonaws.com/${tile}/${tile}.tif`;
await mkdir('public/data', { recursive: true });

let osm;
let overpassUrl;
let previous;
let cachedRoads = false;
if (!process.argv.includes('--refresh-roads')) {
  try {
    osm = JSON.parse(await readFile('public/data/osm-source.json', 'utf8'));
    previous = JSON.parse(await readFile('public/data/provenance.json', 'utf8'));
    if (!osm.elements?.some(e => e.type === 'way')) throw new Error('Persisted OSM source is invalid');
    overpassUrl = previous.roads.endpoint;
    cachedRoads = true;
    console.log('Using persisted OSM source; pass --refresh-roads to deliberately update it.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    osm = undefined;
  }
}
const failures = [];
for (const endpoint of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
  if (osm) break;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(120000),
      headers: { 'User-Agent': 'twingame-geographic-preparation/0.1' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const candidate = await response.json();
    if (!candidate.elements?.some(e => e.type === 'way')) throw new Error('No ways in response');
    osm = candidate;
    overpassUrl = endpoint;
    break;
  } catch (error) {
    const failure = `${endpoint}: ${error.message}`;
    failures.push(failure);
    console.error(failure);
  }
}
if (!osm) throw new Error(`No road source available:\n${failures.join('\n')}`);

const retrievedAt = new Date().toISOString();
const raw = JSON.stringify(osm);
const tiff = await fromUrl(elevationUrl);
const image = await tiff.getImage();
const [originX, originY] = image.getOrigin();
const [resolutionX, resolutionY] = image.getResolution();
const geoKeys = image.getGeoKeys();
const pixelOffset = geoKeys.GTRasterTypeGeoKey === 2 ? 0 : 0.5;
const minCol = Math.floor((bounds.west - originX) / resolutionX) - 1;
const maxCol = Math.ceil((bounds.east - originX) / resolutionX) + 1;
const minRow = Math.floor((bounds.north - originY) / resolutionY) - 1;
const maxRow = Math.ceil((bounds.south - originY) / resolutionY) + 1;
const window = [minCol, minRow, maxCol + 1, maxRow + 1];
const raster = await image.readRasters({ window, samples: [0] });
const values = Array.from(raster[0]);
const noData = image.getGDALNoData();
if (values.some(v => !Number.isFinite(v) || v === noData)) throw new Error('Missing elevation; refusing a flat fallback');
const elevation = {
  cols: maxCol - minCol + 1,
  rows: maxRow - minRow + 1,
  west: originX + (minCol + pixelOffset) * resolutionX,
  north: originY + (minRow + pixelOffset) * resolutionY,
  stepLon: resolutionX,
  stepLat: -resolutionY,
  values,
};
if (Math.max(...values) - Math.min(...values) < 1) throw new Error('Unexpected flat source elevation');
const provenance = {
  bounds,
  origin: { lon: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2 },
  retrievedAt,
  roads: {
    provider: 'OpenStreetMap contributors',
    license: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    endpoint: overpassUrl,
    query,
    osmTimestamp: osm.osm3s?.timestamp_osm_base,
    retrievedAt: cachedRoads ? (previous.roads.retrievedAt || previous.retrievedAt) : retrievedAt,
    rawSha256: createHash('sha256').update(raw + '\n').digest('hex'),
  },
  elevation: {
    provider: 'Copernicus DEM GLO-30 Public (AWS public COG distribution)',
    sourceUrl: elevationUrl,
    documentation: 'https://copernicus-dem-30m.s3.amazonaws.com/readme.html',
    licenseUrl: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
    attribution: '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.',
    modifiedAttribution: 'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    acquisitionPeriod: 'Primarily TanDEM-X 2011–2015; older models may fill gaps. AWS distribution: Copernicus DEM 2021 release.',
    product: 'DSM, not bare-earth DTM',
    verticalDatum: 'EGM2008 orthometric height, metres',
    horizontalDatum: 'WGS84',
    spacingDegrees: { lon: resolutionX, lat: -resolutionY },
    pixelWindow: window,
    pixelCoordinates: `RasterPixelIs${pixelOffset === 0 ? 'Point' : 'Area'}; sample position = GeoTIFF tiepoint origin + (index + ${pixelOffset}) times resolution`,
    geoKeys,
    noData,
    min: Math.min(...values),
    max: Math.max(...values),
  },
};
await Promise.all([
  writeFile('public/data/osm-source.json', raw + '\n'),
  writeFile('public/data/elevation.json', JSON.stringify(elevation) + '\n'),
  writeFile('public/data/provenance.json', JSON.stringify(provenance, null, 2) + '\n'),
]);
console.log(`Saved ${osm.elements.filter(e => e.type === 'way').length} OSM ways and ${elevation.cols}×${elevation.rows} real DSM samples (${provenance.elevation.min.toFixed(1)}–${provenance.elevation.max.toFixed(1)} m).`);
