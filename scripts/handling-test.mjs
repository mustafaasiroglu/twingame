import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

let url = process.env.HANDLING_URL;
const server = process.env.HANDLING_URL ? null : spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '0', '--strictPort',
], { stdio: 'pipe' });
let serverLog = '', browser, page;
server?.stdout.on('data', data => { serverLog += data; });
server?.stderr.on('data', data => { serverLog += data; });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server && server.exitCode !== null) throw new Error(`Handling preview exited: ${serverLog}`);
    if (server) url = stripVTControlCharacters(serverLog).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) {
      try { ready = (await fetch(url)).ok; } catch { /* Expected while our bounded preview starts. */ }
    }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Handling preview did not become ready: ${serverLog}`);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${url}/?scoutTheme=light`);
  await page.bringToFront();
  await page.waitForFunction(() => window.twinGame, null, { polling: 100, timeout: 60000 });
  await page.getByRole('button', { name: 'Sürüşe başla' }).click();
  const initial = await page.evaluate(() => window.twinGame.readState());
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(heading => window.twinGame.readState().heading < heading - 0.55, initial.heading, { polling: 16, timeout: 30000 });
  const turning = await page.evaluate(() => window.twinGame.readState());
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(heading => window.twinGame.readState().heading >= heading - 0.03, initial.heading, { polling: 16, timeout: 30000 });
  await page.keyboard.up('ArrowLeft');
  const aligned = await page.evaluate(() => window.twinGame.readState());
  await page.waitForFunction(distance => window.twinGame.readState().distance > distance + 3, aligned.distance, { polling: 100, timeout: 30000 });
  await page.keyboard.up('ArrowUp');
  const cruising = await page.evaluate(() => window.twinGame.readState());
  assert(turning.onRoad && aligned.onRoad && cruising.onRoad);
  assert(aligned.speed >= turning.speed * 0.9, 'Near-edge countersteering must not trigger premature drag');
  assert(cruising.speed > aligned.speed, 'Returning parallel to the road must permit normal acceleration');
  assert(Math.abs(cruising.y - cruising.roadHeight - 0.08) < 1e-6);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', initial, turning, aligned, cruising }, null, 2));
} catch (error) {
  console.error('Handling check failed:', error);
  if (page && !page.isClosed()) console.error(await page.evaluate(() => ({
    url: location.href, title: document.title, loadStatus: document.getElementById('load-status')?.textContent, state: window.twinGame?.readState(),
  })));
  throw error;
} finally {
  await browser?.close();
  server?.kill();
}
