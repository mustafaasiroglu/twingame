import { project, Terrain, type Bounds, type ElevationData, type Origin } from './geo';
import { RoadNetwork, type RoadSegment } from './roads';
import { createVehicle, Input, stepVehicle } from './vehicle';
import { GameScene, palette } from './scene';
import { ROAD_GRID_METRES, RoadSurface, type GradedSegment } from './surface';
import type { WorldManifest } from './world';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing interface element: ${id}`);
  return value as T;
}
interface Provenance { bounds: Bounds; origin: Origin; retrievedAt: string; region: { radiusMetres: number; osmId: number }; roads: { rawSha256: string } }
async function localJson<T>(name: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${name}.json`);
  if (!response.ok) throw new Error(`${name}: local data HTTP ${response.status}`);
  return response.json();
}
const status = element('load-status');
const startButton = element<HTMLButtonElement>('start-button');
const pauseButton = element<HTMLButtonElement>('pause-button');
const cameraButton = element<HTMLButtonElement>('camera-button');
const resetButton = element<HTMLButtonElement>('reset-button');
const sources = element<HTMLDialogElement>('sources-dialog');
const input = new Input();
let started = false, paused = true, sourcePaused = true;
let reset = () => {};
let changeCamera = () => {};

function setPaused(value: boolean): void {
  paused = value;
  input.clear();
  element('paused').style.display = started && value && !sources.open ? 'block' : 'none';
  pauseButton.innerHTML = value ? 'Devam et <kbd>P</kbd>' : 'Duraklat <kbd>P</kbd>';
}
function start(): void {
  if (startButton.disabled) return;
  started = true;
  document.body.classList.add('started');
  element('welcome').hidden = true;
  setPaused(false);
}
startButton.addEventListener('click', start);
pauseButton.addEventListener('click', () => setPaused(!paused));
element('resume-button').addEventListener('click', () => setPaused(false));
resetButton.addEventListener('click', () => reset());
cameraButton.addEventListener('click', () => changeCamera());
element('map-camera-button').addEventListener('click', () => changeCamera());
element('sources-button').addEventListener('click', () => {
  sourcePaused = paused;
  sources.showModal();
  setPaused(true);
});
element('close-sources').addEventListener('click', () => sources.close());
sources.addEventListener('close', () => setPaused(sourcePaused));

window.addEventListener('keydown', event => {
  if (sources.open) return;
  if (input.setKey(event.code, false)) {
    event.preventDefault();
    if (!started && event.code !== 'Space') start();
    if (!paused) input.setKey(event.code, true);
    return;
  }
  if (event.repeat) return;
  if (event.code === 'KeyP' && started) setPaused(!paused);
  if (event.code === 'KeyR') reset();
  if (event.code === 'KeyV') changeCamera();
  if (event.code === 'Enter' && !started) start();
});
window.addEventListener('keyup', event => {
  if (input.setKey(event.code, false)) event.preventDefault();
});
window.addEventListener('blur', () => { if (started) setPaused(true); else input.clear(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && started) setPaused(true);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-drive]')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    if (!started) start();
    if (paused) return;
    button.setPointerCapture(event.pointerId);
    input.setTouch(String(event.pointerId), button.dataset.drive!);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(name, event => input.setTouch(String((event as PointerEvent).pointerId), null));
  }
}

async function boot(): Promise<void> {
  const [segments, displaySegments, elevation, provenance, manifest, profileResponse] = await Promise.all([
    localJson<RoadSegment[]>('roads'), localJson<RoadSegment[]>('display-roads'), localJson<ElevationData>('elevation'), localJson<Provenance>('provenance'), localJson<WorldManifest>('world'),
    fetch(`${import.meta.env.BASE_URL}data/profiles.bin`),
  ]);
  if (!profileResponse.ok) throw new Error(`Prepared road profiles: HTTP ${profileResponse.status}`);
  if (manifest.sourceSha256 !== provenance.roads.rawSha256) throw new Error('Prepared OSM world does not match source provenance');
  const packed = new Float64Array(await profileResponse.arrayBuffer());
  if (!packed.length || packed.length % 9 || packed.some(v => !Number.isFinite(v))) throw new Error('Invalid prepared road profiles');
  const profiles: GradedSegment[] = [];
  for (let i = 0; i < packed.length; i += 9) profiles.push({ a: { x: packed[i], z: packed[i + 1] }, b: { x: packed[i + 2], z: packed[i + 3] }, width: packed[i + 4], ha: packed[i + 5], hb: packed[i + 6], rawHa: packed[i + 7], rawHb: packed[i + 8], name: '', highway: 'profile', wayId: -1 });
  const sourceTerrain = new Terrain(elevation, provenance.origin);
  if (!segments.length || segments.some(s => ![s.a.x, s.a.z, s.b.x, s.b.z, s.width].every(Number.isFinite))) throw new Error('Invalid prepared road geometry');
  const roads = new RoadNetwork(segments);
  status.textContent = '5 km alanın yerel arazi, bina ve ağaç detayları hazırlanıyor…';
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const terrain = new RoadSurface(sourceTerrain, roads, profiles);
  const scene = new GameScene(element('world'), terrain, new RoadNetwork(displaySegments), manifest);
  const spawn = roads.spawn(provenance.origin);
  await scene.prepare(spawn);
  scene.onError = error => {
    console.error('OSM detail loading failed:', error);
    setPaused(true); startButton.disabled = true; element('welcome').hidden = false;
    status.classList.add('error'); status.textContent = `Yerel harita detayı yüklenemedi: ${error instanceof Error ? error.message : String(error)}. Yeniden yükleyin.`;
  };
  let state = createVehicle(spawn, terrain);
  reset = () => {
    state = createVehicle(spawn, terrain);
    input.clear();
    scene.resetCamera();
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
  };
  changeCamera = () => {
    scene.overview = !scene.overview;
    cameraButton.innerHTML = scene.overview ? 'Takip <kbd>V</kbd>' : 'Kamera <kbd>V</kbd>';
    scene.resetCamera();
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
  };
  startButton.disabled = false;
  pauseButton.disabled = false;
  cameraButton.disabled = false;
  resetButton.disabled = false;
  element<HTMLButtonElement>('map-camera-button').disabled = false;
  status.textContent = `5 km yarıçap · ${(roads.totalLength / 1000).toFixed(0)} km bağlı yol · ${manifest.stats.buildings} OSM bina · ${elevation.cols}×${elevation.rows} kaynak DSM`;
  element('detail-counts').textContent = `${manifest.stats.mappedTrees} konumu işlenmiş ağaç · ${manifest.stats.rowTrees} ağaç sırasından türetilmiş · ${manifest.stats.inferredTrees} tahmini ağaç. Bina yüksekliği: ${manifest.stats.declaredHeights} height etiketi, ${manifest.stats.levelHeights} kat sayısından, ${manifest.stats.defaultHeights} varsayılan/tahmini (normalde 9 m). ${manifest.stats.omittedIncomplete} eksik/kapanmayan OSM geometrisi çizilmedi.`;
  if (manifest.incomplete.length) console.warn('Incomplete source areas were explicitly omitted:', manifest.incomplete);
  element('data-date').textContent = provenance.retrievedAt.slice(0, 10);
  element('network-length').textContent = `${(roads.totalLength / 1000).toFixed(1)} km yol`;

  const map = element<HTMLCanvasElement>('minimap');
  const context = map.getContext('2d');
  if (!context) throw new Error('Map canvas is unavailable');
  const mapBackground = document.createElement('canvas');
  mapBackground.width = map.width; mapBackground.height = map.height;
  const background = mapBackground.getContext('2d');
  if (!background) throw new Error('Map background canvas is unavailable');
  const colors = palette();
  const css = (name: string) => `#${colors[name].getHexString()}`;
  const scale = Math.min((map.width - 32) / (terrain.max.x - terrain.min.x), (map.height - 32) / (terrain.max.z - terrain.min.z));
  const offsetX = (map.width - (terrain.max.x - terrain.min.x) * scale) / 2;
  const offsetZ = (map.height - (terrain.max.z - terrain.min.z) * scale) / 2;
  const mapPoint = (p: { x: number; z: number }) => ({
    x: offsetX + (p.x - terrain.min.x) * scale,
    y: offsetZ + (p.z - terrain.min.z) * scale,
  });
  background.fillStyle = css('surface-soft');
  background.fillRect(0, 0, map.width, map.height);
  for (let r = 0; r < elevation.rows - 1; r++) for (let c = 0; c < elevation.cols - 1; c++) {
    const point = sourceTerrain.vertex(c, r);
    const at = mapPoint(point);
    const value = sourceTerrain.height(point.x, point.z);
    const color = colors['surface-soft'].clone().lerp(colors.border, Math.min(0.8, 0.2 + Math.max(0, value) / 110));
    background.fillStyle = `#${color.getHexString()}`;
    background.fillRect(at.x, at.y, sourceTerrain.dx * scale + 1, sourceTerrain.dz * scale + 1);
  }
  background.strokeStyle = css('text-muted');
  background.lineCap = 'round';
  for (const s of roads.segments) {
    if (s.highway === 'service' || s.highway === 'living_street') continue;
    const a = mapPoint(s.a), b = mapPoint(s.b);
    background.lineWidth = Math.max(0.35, s.width * scale);
    background.beginPath(); background.moveTo(a.x, a.y); background.lineTo(b.x, b.y); background.stroke();
  }
  background.font = '19px "Segoe UI", sans-serif';
  background.fillStyle = css('text');
  const palace = mapPoint(project(provenance.origin.lon, provenance.origin.lat, provenance.origin));
  background.fillText('IHLAMUR KASRI', palace.x - 65, palace.y - 12);
  background.beginPath(); background.arc(palace.x, palace.y, provenance.region.radiusMetres * scale, 0, Math.PI * 2); background.stroke();
  background.fillStyle = css('text-muted');
  background.font = '16px Consolas, monospace';
  background.fillText('2 km', 20, map.height - 14);
  background.strokeStyle = css('text-muted'); background.lineWidth = 2;
  background.beginPath(); background.moveTo(20, map.height - 36); background.lineTo(20 + 2000 * scale, map.height - 36); background.stroke();

  // Read-only inspection surface for reproducible browser checks; never accepts commands.
  Object.defineProperty(window, 'twinGame', { value: Object.freeze({
    readState: () => ({ ...state, started, paused, overview: scene.overview, onRoad: roads.fits(state), roadHeight: terrain.height(state.x, state.z), terrainHeight: sourceTerrain.height(state.x, state.z) }),
    readRenderState: () => scene.readRenderState(state),
    stats: Object.freeze({ segments: roads.segments.length, roadLength: roads.totalLength, elevationSamples: elevation.values.length, surfaceGridMetres: ROAD_GRID_METRES, radiusMetres: provenance.region.radiusMetres, center: provenance.origin, palaceOsmId: provenance.region.osmId, ...manifest.stats }),
  }), configurable: true });
  scene.renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    setPaused(true);
    element('welcome').hidden = false;
    status.classList.add('error');
    status.textContent = 'Grafik bağlamı kayboldu. Sürüş durduruldu; sayfayı yeniden yükleyin.';
    startButton.disabled = true;
  });
  let previous = performance.now(), accumulator = 0, hudElapsed = 1;
  const fixedStep = 1 / 120;
  function frame(now: number): void {
    scene.trackFrame(Math.max(0, now - previous));
    const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
    previous = now;
    if (!paused) {
      accumulator += dt;
      while (accumulator >= fixedStep) {
        stepVehicle(state, input.read(), fixedStep, roads, terrain);
        accumulator -= fixedStep;
      }
    } else accumulator = 0;
    scene.render(state, dt);
    hudElapsed += dt;
    if (hudElapsed >= 0.1) {
      hudElapsed = 0;
      element('speed').textContent = String(Math.round(Math.abs(state.speed) * 3.6)).padStart(2, '0');
      element('altitude').textContent = (state.y - 0.08).toFixed(1);
      element('distance').textContent = (state.distance / 1000).toFixed(2);
      element('road-name').textContent = roads.nearest(state).segment.name + (state.speed < -0.2 ? ' · geri' : '');
      context!.drawImage(mapBackground, 0, 0);
      const at = mapPoint(state);
      context!.save();
      context!.translate(at.x, at.y); context!.rotate(-state.heading);
      context!.fillStyle = css('accent');
      context!.strokeStyle = css('surface'); context!.lineWidth = 3;
      context!.beginPath(); context!.moveTo(0, 11); context!.lineTo(-8, -8); context!.lineTo(0, -4); context!.lineTo(8, -8); context!.closePath();
      context!.fill(); context!.stroke(); context!.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
boot().catch((error: unknown) => {
  console.error('Twin Game could not start:', error);
  status.textContent = `Oyun başlatılamadı: ${error instanceof Error ? error.message : String(error)}. Yerel verileri ve WebGL desteğini kontrol edin.`;
  status.classList.add('error');
  startButton.disabled = true;
});
