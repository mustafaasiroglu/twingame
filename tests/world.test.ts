import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { WorldRenderer, type WorldManifest } from '../src/world';
import { roadPolygons, roadMarkings, surfaceVertices, resolutionRatio } from '../src/scene';
import { RoadNetwork } from '../src/roads';
import { network, surface, provenance } from './data';

it('reduces only 3D pixel density under sustained frame pressure, with bounded recovery and unchanged geographic resolution', () => {
  expect(resolutionRatio(1, 1.75, 60)).toBe(0.8);
  expect(resolutionRatio(0.5, 1.75, 200)).toBe(0.5);
  expect(resolutionRatio(1, 1.75, 16)).toBe(1.05);
  expect(resolutionRatio(1.75, 1.75, 16)).toBe(1.75);
  expect(resolutionRatio(1, 1.75, 30)).toBe(1);
});

it('builds actual Ihlamur terrain, dense junctions, both palaces and source detail tiles', async () => {
  vi.stubGlobal('document', { documentElement: { dataset: { theme: 'light' } } });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('fetch', async (url: string) => {
    const name = url.split('/').pop();
    return new Response(readFileSync(`public/data/tiles/${name}`, 'utf8'));
  });
  try {
    const manifest: WorldManifest = JSON.parse(readFileSync('public/data/world.json', 'utf8'));
    const colors = Object.fromEntries(['surface', 'surface-soft', 'success', 'border', 'border-strong', 'text', 'text-muted', 'link'].map(k => [k, new THREE.Color()]));
    const display = new RoadNetwork(JSON.parse(readFileSync('public/data/display-roads.json', 'utf8')));
    const world = new WorldRenderer(new THREE.Scene(), surface, display, colors, { polygons: roadPolygons, markings: roadMarkings, vertices: surfaceVertices }, manifest, new THREE.MeshStandardMaterial());
    await world.update(network.spawn(provenance.origin));
    const state = world.diagnostics();
    expect(state.activeChunks).toBe(121);
    expect(state.palaceBuildings.map(b => b.id).sort()).toEqual(['way/312484207', 'way/312484208']);
    expect(state.activeBuildings).toBeGreaterThan(50);
    expect(state.focusTilesLoaded).toBe(true);
  } finally { vi.unstubAllGlobals(); }
}, 60000);
