import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const url = 'http://127.0.0.1:5174';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { stdio: 'pipe' });
let serverLog = '';
server.stdout.on('data', data => { serverLog += data; });
server.stderr.on('data', data => { serverLog += data; });
let browser;
const screenshots = process.env.SCREENSHOT_DIR || 'test-results';
await mkdir(screenshots, { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(`Preview exited: ${serverLog}`);
    try { ready = (await fetch(url)).ok; } catch { /* Expected until our own preview is listening. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Preview failed to become ready: ${serverLog}`);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(url)) external.push(request.url()); });
  await page.goto(`${url}/?scoutTheme=light`);
  await page.bringToFront();
  await page.waitForFunction(() => window.twinGame, null, { timeout: 60000, polling: 100 });
  await page.getByRole('button', { name: 'Sürüşe başla' }).click();
  const read = () => page.evaluate(() => window.twinGame.readState());
  const initial = await read();
  assert(!initial.paused && initial.onRoad);
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.twinGame.readState().distance > 3, null, { timeout: 15000, polling: 100 });
  await page.keyboard.up('ArrowUp');
  const driven = await read();
  assert(driven.distance > 2, 'ArrowUp must visibly move the vehicle');
  assert(driven.speed > 1 && driven.onRoad, 'Vehicle must accelerate on a road');
  assert(Math.abs(driven.y - driven.terrainHeight - 0.08) < 1e-6);
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
  await page.keyboard.up('ArrowLeft'); await page.keyboard.up('ArrowUp');
  assert((await read()).heading > initial.heading, 'ArrowLeft must change steering');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert((await read()).paused, 'Losing focus must pause and release inputs');
  await page.keyboard.press('KeyP');
  await page.keyboard.press('KeyR');
  await page.keyboard.press('KeyP');
  await page.evaluate(() => { document.getElementById('paused').style.display = 'none'; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(screenshots, 'eminonu-sirkeci-chase.png') });
  await page.keyboard.press('KeyV');
  assert((await read()).overview);
  // Hide only the pause overlay for a clean screenshot, while simulation stays stopped.
  await page.evaluate(() => { document.getElementById('paused').style.display = 'none'; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(screenshots, 'eminonu-sirkeci-overview.png') });
  await page.getByRole('button', { name: 'Veri ve sınırlar' }).click();
  await page.getByRole('dialog').waitFor();
  assert((await page.getByRole('dialog').innerText()).includes('produced using Copernicus WorldDEM-30'));
  await page.getByRole('button', { name: 'Sürüşe dön' }).click();
  assert((await read()).paused, 'Closing sources must preserve pause state');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${url}/?scoutTheme=dark`);
  await page.waitForFunction(() => window.twinGame, null, { timeout: 60000, polling: 100 });
  await page.getByRole('button', { name: 'Sürüşe başla' }).click();
  await page.screenshot({ path: path.join(screenshots, 'eminonu-sirkeci-dark.png') });
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
  await mobile.screenshot({ path: path.join(screenshots, 'eminonu-sirkeci-mobile.png') });
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
  await failurePage.goto(url);
  await failurePage.locator('#load-status.error').waitFor();
  assert(await failurePage.getByRole('button', { name: 'Sürüşe başla' }).isDisabled());
  assert((await failurePage.locator('#load-status').innerText()).includes('elevation'));
  assert.equal(await failurePage.evaluate(() => Boolean(window.twinGame)), false, 'Missing elevation must never produce a fake flat game');
  await failurePage.close();
  assert.deepEqual(external, [], 'Gameplay must use only persisted local data and assets');
  assert.deepEqual(errors, [], 'Browser must have no runtime/console errors');
  console.log(JSON.stringify({ result: 'PASS', checks: ['local-only requests', 'WebGL render', 'arrow acceleration', 'reverse', 'steering', 'ground height', 'pause/focus loss', 'reset', 'overview including touch', 'attribution', 'dark theme', 'mobile layout', 'multi-touch driving', 'graphics-context loss handling', 'explicit missing-elevation failure', 'zero unexpected browser errors'], screenshots, stats }, null, 2));
} catch (error) {
  if (browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      console.error('Failed browser page:', page.url(), await page.locator('#load-status').textContent().catch(() => 'No load status'), await page.evaluate(() => window.twinGame?.readState()));
    }
  }
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill();
}
