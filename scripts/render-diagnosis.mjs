import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const directory = process.env.SCREENSHOT_DIR || 'test-results';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
try {
  for (const zeroNegativeOffset of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(zero => {
      window.depthDiagnosis = { negativeCalls: 0 };
      const original = WebGL2RenderingContext.prototype.polygonOffset;
      WebGL2RenderingContext.prototype.polygonOffset = function (factor, units) {
        if (factor < 0) window.depthDiagnosis.negativeCalls++;
        return original.call(this, zero && factor < 0 ? 0 : factor, zero && units < 0 ? 0 : units);
      };
    }, zeroNegativeOffset);
    await page.goto(`${url}/?scoutTheme=light`);
    await page.bringToFront();
    await page.waitForFunction(() => window.twinGame, null, { timeout: 60000, polling: 100 });
    await page.getByRole('button', { name: 'Sürüşe başla' }).click();
    await page.keyboard.press('KeyP');
    await page.evaluate(() => { document.getElementById('paused').style.display = 'none'; });
    const result = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const canvas = document.querySelector('#world canvas');
      const gl = canvas.getContext('webgl2');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let whitePixelsAhead = 0;
      for (let y = Math.floor(canvas.height * 0.28); y < canvas.height * 0.53; y++) {
        for (let x = Math.floor(canvas.width * 0.42); x < canvas.width * 0.58; x++) {
          const index = ((canvas.height - y - 1) * canvas.width + x) * 4;
          if (pixels[index] > 225 && pixels[index + 1] > 225 && pixels[index + 2] > 225) whitePixelsAhead++;
        }
      }
      resolve({ ...window.depthDiagnosis, whitePixelsAhead, state: window.twinGame.readState() });
    })));
    const name = zeroNegativeOffset ? 'road-markings-without-negative-offset.png' : 'road-markings-current-depth.png';
    await page.screenshot({ path: path.join(directory, name) });
    console.log(JSON.stringify({ zeroNegativeOffset, ...result }, null, 2));
    await page.close();
  }
} finally {
  await browser.close();
}
