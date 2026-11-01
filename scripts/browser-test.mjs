import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

function inspectRoadVisuals(page, whiteThreshold) {
  return page.evaluate(threshold => new Promise(resolve => requestAnimationFrame(() => {
    const details = window.twinGame.readRenderState();
    const canvas = document.querySelector('#world canvas'), gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let visibleForwardMarks = 0;
    for (const point of details.forwardMarkings) {
      if (point.ahead < 8 || point.ahead > 50) continue;
      const px = Math.round(point.x * canvas.width), py = Math.round((1 - point.y) * canvas.height);
      let visible = false;
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const index = ((py + oy) * canvas.width + px + ox) * 4;
        if (pixels[index] > threshold && pixels[index + 1] > threshold && pixels[index + 2] > threshold) visible = true;
      }
      if (visible) visibleForwardMarks++;
    }
    resolve({ ...details, visibleForwardMarks });
  })), whiteThreshold);
}

const url = (process.env.BROWSER_URL || `http://127.0.0.1:5174${process.env.BROWSER_BASE_PATH || ''}`).replace(/\/$/, '');
const server = process.env.BROWSER_URL ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5174', '--strictPort', '--base', `${process.env.BROWSER_BASE_PATH || ''}/`], { stdio: 'pipe' });
let serverLog = '';
server?.stdout.on('data', data => { serverLog += data; });
server?.stderr.on('data', data => { serverLog += data; });
let browser;
const screenshots = process.env.SCREENSHOT_DIR || 'test-results';
const prefix = process.env.SCREENSHOT_PREFIX || 'ihlamur';
await mkdir(screenshots, { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server && server.exitCode !== null) throw new Error(`Preview exited: ${serverLog}`);
    try { ready = (await fetch(`${url}/`)).ok; } catch { /* Expected until our own preview is listening. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Preview failed to become ready: ${serverLog}`);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const errors = [], external = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser exception:', error.stack); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(url)) external.push(request.url()); });
  await page.goto(`${url}/?scoutTheme=light`);
  await page.bringToFront();
  await page.waitForFunction(() => window.twinGame, null, { timeout: 60000, polling: 100 });
  await page.getByRole('button', { name: 'Sürüşe başla' }).click();
  const read = () => page.evaluate(() => window.twinGame.readState());
  const initial = await read();
  assert(!initial.paused && initial.onRoad);
  const visual = await inspectRoadVisuals(page, 245);
  assert(visual.visibleForwardMarks > 0, 'Lane paint must be visible 8–50 m ahead, before driving over it');
  assert(visual.roadMaxEdge <= Math.sqrt(2) * 3 + 1e-5 && visual.roadTriangles > 10000, 'Road polygons must use the fine shared 3 m surface');
  assert(visual.asphaltTextured && visual.asphaltTileMetres === 4);
  assert(visual.carParts > 25, 'Vehicle must have detailed body, cabin, windows, wheels and lamps');
  assert(visual.activeChunks === 121 && visual.activeBuildings > 50 && visual.activeTrees > 10, 'Nearby source details must load into bounded terrain/detail chunks');
  assert.deepEqual(visual.palaceBuildings.map(b => b.id).sort(), ['way/312484207', 'way/312484208'], 'Both actual palace footprints must render near the real OSM centre');
  assert(visual.focusTilesLoaded, 'All tiles intersecting the palace footprints must render at detail LOD, not just a clipped fragment');
  assert(visual.palaceBuildings.every(b => b.heightSource === 'default' && b.height === 9 && Math.abs(b.roofHeight - b.siteHeight - 9) < 1e-8), 'Palace roofs must use explicitly inferred heights above actual sampled terrain');
  assert(visual.sidewalksMapped + visual.sidewalksInferred > 0, 'Roadside detail must be present without covering the asphalt');
  const gx = Math.tan(initial.roll), gz = Math.tan(initial.pitch);
  const expectedRightY = gx / Math.sqrt((1 + gz * gz) * (1 + gx * gx + gz * gz));
  assert(Math.abs(visual.forward[1] - Math.sin(initial.pitch)) < 1e-6 && Math.abs(visual.right[1] - expectedRightY) < 1e-6, 'Actual rendered vehicle axes must match the road tangent, not be flat or reversed');
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.twinGame.readState().distance > 3, null, { timeout: 15000, polling: 100 });
  await page.keyboard.up('ArrowUp');
  const driven = await read();
  assert(driven.distance > 2, 'ArrowUp must visibly move the vehicle');
  assert(driven.speed > 1 && driven.onRoad, 'Vehicle must accelerate on a road');
  assert(Math.abs(driven.y - driven.roadHeight - 0.08) < 1e-6);
  await page.keyboard.press('KeyP');
  const paused = await read();
  assert(paused.paused);
  await page.waitForTimeout(300);
  assert.equal((await read()).distance, paused.distance, 'Pause must stop movement');
  await page.keyboard.press('KeyP');
  await page.keyboard.down('ArrowDown');
  await page.waitForFunction(() => window.twinGame.readState().speed < -0.5, null, { timeout: 15000, polling: 100 });
  await page.keyboard.up('ArrowDown');
  assert((await read()).speed < 0, 'ArrowDown brakes then reverses');
  await page.keyboard.press('KeyR');
  const reset = await read();
  assert.equal(reset.distance, 0);
  assert.equal(reset.speed, 0);
  assert(Math.hypot(reset.x - initial.x, reset.z - initial.z) < 0.001);
  await page.keyboard.down('ArrowUp'); await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(heading => window.twinGame.readState().heading > heading + 0.03, initial.heading, { timeout: 15000, polling: 100 });
  assert((await page.evaluate(() => window.twinGame.readRenderState())).frontWheelSteer > 0, 'Front wheels must visibly steer with the input');
  await page.keyboard.up('ArrowLeft'); await page.keyboard.up('ArrowUp');
  assert((await read()).heading > initial.heading, 'ArrowLeft must change steering');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert((await read()).paused, 'Losing focus must pause and release inputs');
  await page.keyboard.press('KeyP');
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => {
    const world = window.twinGame.readRenderState();
    return world.chunkCenter === world.targetChunkCenter && !world.loadingChunks;
  }, null, { timeout: 60000, polling: 100 });
  const chunkCenter = (await page.evaluate(() => window.twinGame.readRenderState())).chunkCenter;
  const sourceRoads = JSON.parse(await readFile('public/data/roads.json', 'utf8'));
  const firstRoad = sourceRoads.find(s => s.wayId === 43960781), branch = sourceRoads.find(s => s.wayId === 229739448);
  assert(firstRoad && branch, 'The source-connected local streaming route must exist');
  const turnHeading = Math.atan2(branch.a.x - branch.b.x, branch.a.z - branch.b.z) + Math.PI * 2;
  await page.evaluate(() => {
    const samples = { heartbeat: [], frames: [] }, clocks = { heartbeat: performance.now(), frames: performance.now() };
    const timer = setInterval(() => { const now = performance.now(); samples.heartbeat.push(now - clocks.heartbeat); clocks.heartbeat = now; }, 50);
    let running = true;
    const frame = now => { samples.frames.push(now - clocks.frames); clocks.frames = now; if (running) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    window.stopStreamMeasurement = () => { running = false; clearInterval(timer); return samples; };
  });
  let crossed = false;
  for (let i = 0; i < 250; i++) {
    const state = await read();
    assert(state.onRoad && !state.paused, 'Actual key-driven chunk transition must remain comfortably on asphalt');
    if ((await page.evaluate(() => window.twinGame.readRenderState())).targetChunkCenter !== chunkCenter) { crossed = true; break; }
    const target = state.x > firstRoad.a.x + 4 ? initial.heading : turnHeading;
    const error = Math.atan2(Math.sin(target - state.heading), Math.cos(target - state.heading));
    if (error > 0.04) { await page.keyboard.up('ArrowRight'); await page.keyboard.down('ArrowLeft'); }
    else if (error < -0.04) { await page.keyboard.up('ArrowLeft'); await page.keyboard.down('ArrowRight'); }
    else { await page.keyboard.up('ArrowLeft'); await page.keyboard.up('ArrowRight'); }
    if (state.speed < 4.5) await page.keyboard.down('ArrowUp'); else await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(100);
  }
  for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowRight']) await page.keyboard.up(key);
  assert(crossed, 'Real arrow steering must cross the terrain-chunk boundary, not just test the initial scene');
  await page.keyboard.down('Space');
  await page.waitForFunction(() => Math.abs(window.twinGame.readState().speed) < 0.1, null, { timeout: 10000, polling: 100 });
  await page.keyboard.up('Space');
  await page.waitForFunction(center => {
    const world = window.twinGame.readRenderState();
    return world.chunkCenter !== center && !world.loadingChunks;
  }, chunkCenter, { timeout: 60000, polling: 100 });
  const streamWorld = await page.evaluate(() => window.twinGame.readRenderState());
  const timings = await page.evaluate(() => window.stopStreamMeasurement());
  const sortedFrames = timings.frames.slice(2).sort((a, b) => a - b);
  const performance = { renderer: 'headless Chromium / SwiftShader', medianFrameMs: sortedFrames[Math.floor(sortedFrames.length / 2)], p95FrameMs: sortedFrames[Math.floor(sortedFrames.length * 0.95)], maxHeartbeatMs: Math.max(...timings.heartbeat), pixelRatio: streamWorld.pixelRatio, from: chunkCenter, to: streamWorld.chunkCenter, activeChunks: streamWorld.activeChunks };
  console.log('Streaming measurement:', performance);
  assert(timings.heartbeat.length > 20 && Math.max(...timings.heartbeat) < 1000, 'Mesh streaming must keep the main event loop responsive, without synchronous multisecond polygon stalls');
  assert.equal(streamWorld.activeChunks, 121, 'Old chunks must be evicted after a real transition');
  await page.keyboard.press('KeyR');
  await page.waitForFunction(center => {
    const world = window.twinGame.readRenderState();
    return world.chunkCenter === center && !world.loadingChunks;
  }, chunkCenter, { timeout: 60000, polling: 100 });
  await page.waitForFunction(() => document.getElementById('speed').textContent === '00', null, { timeout: 10000, polling: 100 });
  await page.keyboard.press('KeyP');
  await page.evaluate(() => { document.getElementById('paused').style.display = 'none'; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(screenshots, `${prefix}-chase.png`) });
  await page.keyboard.press('KeyV');
  assert((await read()).overview);
  // Hide only the pause overlay for a clean screenshot, while simulation stays stopped.
  await page.evaluate(() => { document.getElementById('paused').style.display = 'none'; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(screenshots, `${prefix}-overview.png`) });
  await page.getByRole('button', { name: 'Veri ve sınırlar' }).click();
  await page.getByRole('dialog').waitFor();
  assert((await page.getByRole('dialog').innerText()).includes('produced using Copernicus WorldDEM-30'));
  await page.getByRole('button', { name: 'Sürüşe dön' }).click();
  assert((await read()).paused, 'Closing sources must preserve pause state');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${url}/?scoutTheme=dark`);
  await page.waitForFunction(() => window.twinGame, null, { timeout: 60000, polling: 100 });
  await page.getByRole('button', { name: 'Sürüşe başla' }).click();
  assert((await inspectRoadVisuals(page, 210)).visibleForwardMarks > 0, 'Forward paint must stay visible in dark theme too');
  await page.screenshot({ path: path.join(screenshots, `${prefix}-dark.png`) });
  const stats = await page.evaluate(() => window.twinGame.stats);
  await page.close();
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const mobile = await mobileContext.newPage();
  await mobile.bringToFront();
  mobile.on('pageerror', error => errors.push(error.message));
  mobile.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  mobile.on('request', request => { if (!request.url().startsWith(url)) external.push(request.url()); });
  await mobile.goto(`${url}/?scoutTheme=light`);
  await mobile.waitForFunction(() => window.twinGame, null, { timeout: 60000, polling: 100 });
  await mobile.getByRole('button', { name: 'Sürüşe başla' }).tap();
  const gas = await mobile.locator('[data-drive="ArrowUp"]').boundingBox();
  const left = await mobile.locator('[data-drive="ArrowLeft"]').boundingBox();
  assert(gas && left, 'Touch controls must be visible');
  const mobileStart = await mobile.evaluate(() => window.twinGame.readState());
  const cdp = await mobileContext.newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
    { x: gas.x + gas.width / 2, y: gas.y + gas.height / 2, id: 1 },
    { x: left.x + left.width / 2, y: left.y + left.height / 2, id: 2 },
  ] });
  await mobile.waitForFunction(heading => {
    const state = window.twinGame.readState();
    return state.distance > 0.7 && state.heading > heading + 0.03;
  }, mobileStart.heading, { timeout: 15000, polling: 100 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const mobileDriven = await mobile.evaluate(() => window.twinGame.readState());
  assert(mobileDriven.distance > 0.5 && mobileDriven.heading > mobileStart.heading, 'Two fingers must accelerate and steer together');
  assert(mobileDriven.onRoad);
  await mobile.getByRole('button', { name: 'Başa dön' }).tap();
  await mobile.waitForFunction(() => document.getElementById('speed').textContent === '00', null, { timeout: 10000, polling: 100 });
  await mobile.screenshot({ path: path.join(screenshots, `${prefix}-mobile.png`) });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole('button', { name: 'Kamera görünümünü değiştir' }).tap();
  assert((await mobile.evaluate(() => window.twinGame.readState())).overview, 'Touch users must also have an overview camera');
  await mobile.evaluate(() => document.querySelector('#world canvas').dispatchEvent(new Event('webglcontextlost', { bubbles: false, cancelable: true })));
  assert((await mobile.evaluate(() => window.twinGame.readState())).paused);
  assert(await mobile.getByRole('button', { name: 'Sürüşe başla' }).isDisabled());
  assert((await mobile.locator('#load-status').innerText()).includes('Grafik bağlamı kayboldu'));
  await mobileContext.close();
  const failurePage = await browser.newPage();
  await failurePage.route(`${url}/data/elevation.json`, route => route.fulfill({ status: 404, body: 'Missing source raster' }));
  await failurePage.goto(`${url}/`);
  await failurePage.locator('#load-status.error').waitFor();
  assert(await failurePage.getByRole('button', { name: 'Sürüşe başla' }).isDisabled());
  assert((await failurePage.locator('#load-status').innerText()).includes('elevation'));
  assert.equal(await failurePage.evaluate(() => Boolean(window.twinGame)), false, 'Missing elevation must never produce a fake flat game');
  await failurePage.close();
  assert.deepEqual(external, [], 'Gameplay must use only persisted local data and assets');
  assert.deepEqual(errors, [], 'Browser must have no runtime/console errors');
  console.log(JSON.stringify({ result: 'PASS', checks: ['local-only requests', 'Ihlamur palace footprints and inferred heights', 'bounded chunks with buildings/trees/sidewalks', 'real arrow-driven chunk transition and main-thread responsiveness', 'WebGL render', 'forward-visible lane paint', '3 m road tessellation', 'procedural asphalt scale', 'detailed vehicle and correct lean', 'arrow acceleration', 'reverse', 'steering', 'engineered road height', 'pause/focus loss', 'reset', 'overview including touch', 'attribution', 'dark theme', 'mobile layout', 'multi-touch driving', 'graphics-context loss handling', 'explicit missing-elevation failure', 'zero unexpected browser errors'], render: { visibleForwardMarks: visual.visibleForwardMarks, roadTriangles: visual.roadTriangles, roadMaxEdge: visual.roadMaxEdge, carParts: visual.carParts, chunks: visual.activeChunks, buildings: visual.activeBuildings, trees: visual.activeTrees, palaceBuildings: visual.palaceBuildings, drawCalls: visual.drawCalls, triangles: visual.triangles }, performance, screenshots, stats }, null, 2));
} catch (error) {
  if (browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      console.error('Failed browser page:', page.url(), await page.locator('#load-status').textContent().catch(() => 'No load status'), await page.evaluate(() => ({ state: window.twinGame?.readState(), render: window.twinGame?.readRenderState() })));
    }
  }
  throw error;
} finally {
  if (browser) await browser.close();
  server?.kill();
}
