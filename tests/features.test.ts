import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terrain, unproject, closestPoint, project } from '../src/geo';
import { extractFeatures, inferTrees, inside, joinRings, buildingHeight, type AreaFeature, type FeatureData } from '../src/features';
import { RoadNetwork, extractRoads, type OsmData, type OsmNode, type OsmWay } from '../src/roads';
import { roadPolygons } from '../src/scene';
import { buildingVertices, sidewalkPolygons, surfaceEdge, type DetailTile, type WorldManifest } from '../src/world';
import { source, network, surface, provenance } from './data';
import type { Ring } from 'polygon-clipping';

const origin = { lat: 0, lon: 0 };
const node = (id: number, x: number, z: number, tags = {}): OsmNode => ({ type: 'node', id, ...unproject({ x, z }, origin), tags });
const area = (id: string, ring: Ring, tags: Record<string, string>, holes: Ring[] = []): AreaFeature => ({
  id, polygons: [[ring, ...holes]], tags, kind: 'green', min: { x: -80, z: -80 }, max: { x: 80, z: 80 }, height: 9, minHeight: 0, heightSource: 'default',
});
const outer: Ring = [[-80, -80], [80, -80], [80, 80], [-80, 80], [-80, -80]];
const hole: Ring = [[-12, -12], [12, -12], [12, 12], [-12, 12], [-12, -12]];
const road = { a: { x: -200, z: 0 }, b: { x: 200, z: 0 }, width: 8, name: '', highway: 'residential', wayId: 1 };
const roads = new RoadNetwork([road]);
const blank: FeatureData = { areas: [], trees: [], paths: [], rows: [], incomplete: [], radiusMetres: 500 };

describe('OSM detail geometry and provenance', () => {
  it('joins reversed member ways and preserves courtyard holes without closing incomplete relations artificially', () => {
    expect(joinRings([[1, 2, 3], [1, 4, 3]])).toEqual({ rings: [[1, 2, 3, 4, 1]], complete: true });
    expect(joinRings([[1, 2], [3, 4]]).complete).toBe(false);
    const osm: OsmData = { elements: [
      node(1, -30, -30), node(2, 30, -30), node(3, 30, 30), node(4, -30, 30),
      node(5, -10, -10), node(6, 10, -10), node(7, 10, 10), node(8, -10, 10),
      { type: 'way', id: 1, nodes: [1, 2, 3], tags: {} }, { type: 'way', id: 2, nodes: [1, 4, 3], tags: {} },
      { type: 'way', id: 3, nodes: [5, 6, 7, 8, 5], tags: {} },
      { type: 'relation', id: 10, tags: { type: 'multipolygon', building: 'yes', height: '12 m' }, members: [{ type: 'way', ref: 1, role: 'outer' }, { type: 'way', ref: 2, role: 'outer' }, { type: 'way', ref: 3, role: 'inner' }] },
    ] };
    const features = extractFeatures(osm, origin, 100);
    expect(features.areas).toHaveLength(1);
    expect(features.areas[0].polygons[0]).toHaveLength(2);
    expect(inside({ x: 0, z: 0 }, features.areas[0].polygons)).toBe(false);
    expect(inside({ x: 20, z: 0 }, features.areas[0].polygons)).toBe(true);
    expect(features.areas[0].heightSource).toBe('height');
    expect(features.incomplete).toEqual([]);
  });
  it('uses height before levels, converts feet and labels defaults/minimum-height conflicts as inferred', () => {
    expect(buildingHeight({ height: '12 m', 'building:levels': '20' }).height).toBe(12);
    expect(buildingHeight({ height: '30 ft' }).height).toBeCloseTo(9.144);
    expect(buildingHeight({ 'building:levels': '4', 'roof:height': '2' })).toMatchObject({ height: 14, heightSource: 'levels' });
    expect(buildingHeight({})).toMatchObject({ height: 9, heightSource: 'default' });
    expect(buildingHeight({ height: '4', min_height: '10' })).toMatchObject({ height: 11, heightSource: 'default' });
  });
  it('drapes building wall bases, uses a stable level roof and leaves its roof courtyard open', () => {
    const data = { cols: 2, rows: 2, west: -0.002, north: 0.002, stepLon: 0.004, stepLat: 0.004, values: [-30, 10, 10, 50] };
    const terrain = new Terrain(data, origin), result = buildingVertices([[outer, hole]], terrain, 12);
    expect(result.roofHeight - result.siteHeight).toBe(12);
    for (let i = 0; i < result.vertices.length; i += 3) {
      const [x, y, z] = result.vertices.slice(i, i + 3);
      if (y !== result.roofHeight) expect(y).toBeCloseTo(terrain.height(x, z) - 0.15, 8);
    }
    for (let i = 0; i < result.vertices.length; i += 9) {
      const vertices = result.vertices.slice(i, i + 9);
      if ([vertices[1], vertices[4], vertices[7]].every(y => y === result.roofHeight)) expect(inside({ x: (vertices[0] + vertices[3] + vertices[6]) / 3, z: (vertices[2] + vertices[5] + vertices[8]) / 3 }, [[hole]])).toBe(false);
    }
  });
  it('keeps sidewalk surfaces outside asphalt, without changing drivable width or footprint', () => {
    const sidewalk = sidewalkPolygons([road], { polygons: roadPolygons });
    expect(inside({ x: 0, z: 0 }, sidewalk)).toBe(false);
    expect(inside({ x: 0, z: 4.75 }, sidewalk)).toBe(true);
    expect(roads.fits({ x: 0, z: 2.9, heading: Math.PI / 2 })).toBe(true);
    expect(roads.contains({ x: 0, z: 4.5 })).toBe(false);
  });
  it('splits curb and wall edges at every terrain triangle crossing rather than spanning height changes with floating fins', () => {
    const tile = surface.tile(26, 26);
    const points = surfaceEdge([tile.min.x + 1, tile.min.z + 1.5], [tile.min.x + 60, tile.min.z + 20], tile);
    expect(points.length).toBeGreaterThan(30);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], midpoint = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      expect(tile.height(midpoint.x, midpoint.z)).toBeCloseTo((tile.height(a.x, a.z) + tile.height(b.x, b.z)) / 2, 7);
    }
    const lastCol = Math.floor((surface.max.x - surface.min.x) / 192), lastRow = Math.floor((surface.max.z - surface.min.z) / 192);
    expect(surface.tile(lastCol, 26).max.x).toBeGreaterThan(5000);
    expect(surface.tile(26, lastRow).max.z).toBeGreaterThan(5000);
  });
});

describe('mapped and deterministic inferred vegetation', () => {
  it('keeps actual node positions and suppresses random planting in polygons with mapped tree information', () => {
    const way: OsmWay = { type: 'way', id: 9, nodes: [1, 2, 3, 4, 1], tags: { leisure: 'garden' } };
    const data = extractFeatures({ elements: [node(1, -80, -80), node(2, 80, -80), node(3, 80, 80), node(4, -80, 80), way, node(20, 30, 20, { natural: 'tree', height: '11' })] }, origin, 200);
    const trees = inferTrees(data, roads);
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({ source: 'node', id: 'node/20', height: 11 });
    expect(trees[0].x).toBeCloseTo(30, 8); expect(trees[0].z).toBeCloseTo(20, 8);
    const rowData = { ...blank, areas: [area('green', outer, { leisure: 'garden' })], rows: [{ id: 'row', points: [{ x: -100, z: -35 }, { x: 100, z: -35 }], width: 1, sidewalk: false }] };
    expect(inferTrees(rowData, roads).every(t => t.source === 'row')).toBe(true);
  });
  it('seeds repeatably inside polygon holes/exclusions and leaves explicit lawns and pitches unplanted', () => {
    const green = area('park/1', outer, { leisure: 'park' }, [hole]);
    const water = { ...area('water', [[20, 20], [60, 20], [60, 60], [20, 60], [20, 20]], {}), kind: 'water' as const };
    const building = { ...area('building', [[-60, 20], [-20, 20], [-20, 60], [-60, 60], [-60, 20]], {}), kind: 'building' as const };
    const data = { ...blank, areas: [green, water, building], paths: [{ id: 'path', points: [{ x: 0, z: -80 }, { x: 0, z: 80 }], width: 2, sidewalk: false }] };
    const first = inferTrees(data, roads);
    expect(first.length).toBeGreaterThan(5);
    expect(first).toEqual(inferTrees({ ...data, areas: [...data.areas].reverse() }, roads));
    for (const tree of first) {
      expect(inside(tree, green.polygons)).toBe(true);
      expect(inside(tree, water.polygons) || inside(tree, building.polygons)).toBe(false);
      expect(closestPoint(tree, road.a, road.b).distance).toBeGreaterThanOrEqual(8);
      expect(Math.abs(tree.x)).toBeGreaterThanOrEqual(4);
    }
    const lawns: Record<string, string>[] = [{ leisure: 'pitch' }, { leisure: 'park', landcover: 'grass' }, { landuse: 'meadow' }, { landuse: 'grass' }];
    for (const tags of lawns) {
      expect(inferTrees({ ...blank, areas: [area('lawn', outer, tags)] }, roads)).toEqual([]);
    }
    const privateRoad = { id: 'private', points: [{ x: -80, z: -40 }, { x: 80, z: -40 }], width: 6, sidewalk: false };
    const excluded = inferTrees({ ...data, clearancePaths: [privateRoad] }, roads);
    expect(excluded.every(t => Math.abs(t.z + 40) >= 6)).toBe(true);
  });
});

describe('actual Ihlamur region and static coverage', () => {
  it('uses the resolved palace OSM id and true 5 km radius rather than the old location or a guessed centre', () => {
    expect(provenance.region.osmId).toBe(312484207);
    expect(provenance.region.radiusMetres).toBe(5000);
    expect(provenance.origin).toEqual({ lon: 29.0011982, lat: 41.0507128 });
    expect(network.segments.every(s => [s.a, s.b].every(p => Math.hypot(p.x, p.z) + s.width / 2 <= 5000 + 1e-6))).toBe(true);
    expect(Math.hypot(network.spawn(provenance.origin).x, network.spawn(provenance.origin).z)).toBeLessThan(250);
    expect(provenance.elevation.sources).toHaveLength(2);
    expect(provenance.elevation.sources.every(s => s.geoKeys.GTRasterTypeGeoKey === 2)).toBe(true);
    const meridian = project(29, provenance.origin.lat, provenance.origin);
    expect(Number.isFinite(source.height(meridian.x, meridian.z))).toBe(true);
  });
  it('contains both real palace footprints, mapped trees and complete static detail tiles without parsing the giant raw source in gameplay', () => {
    const world: WorldManifest = JSON.parse(readFileSync('public/data/world.json', 'utf8'));
    expect(world.sourceSha256).toBe(provenance.roads.rawSha256);
    expect(world.stats.buildings).toBeGreaterThan(10000); expect(world.stats.mappedTrees).toBeGreaterThan(100);
    const center = `${Math.floor(-source.min.x / 192)}_${Math.floor(-source.min.z / 192)}`;
    const tile: DetailTile = JSON.parse(readFileSync(`public/data/tiles/${center}.json`, 'utf8'));
    const palace = tile.areas.find(a => a.id === 'way/312484207');
    expect(palace?.heightSource).toBe('default');
    expect(palace?.height).toBe(9);
    expect(palace?.polygons[0][0].length).toBeGreaterThan(8);
    expect(world.tiles.length).toBeGreaterThan(1000);
    expect(surface.profiles.every(p => Math.abs(p.hb - p.ha) <= 0.12 * Math.hypot(p.b.x - p.a.x, p.b.z - p.a.z) + 1e-7)).toBe(true);
  });
  it('clips source road segments analytically to the circular driveable region', () => {
    const osm: OsmData = { elements: [node(1, -100, 0), node(2, 100, 0), { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } }] };
    const selected = extractRoads(osm, { west: -0.01, east: 0.01, south: -0.01, north: 0.01 }, origin, 50);
    expect(selected[0].a.x).toBeCloseTo(-46.5);
    expect(selected[0].b.x).toBeCloseTo(46.5);
  });
});
