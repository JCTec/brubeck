// End-to-end test for Brubeck Lab against the REAL WebAssembly build.
//
//   wasm-pack build crates/brubeck-wasm --target web --out-dir ../../web/pkg
//   cd web && npm install && npx playwright install chromium && npm run test:e2e
//
// Serves web/ on a local port, plays through all six lessons the way a
// learner would, and checks the regressions found in review. Exits non-zero
// on any failure.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const path = join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Resource failures are tracked per request so third-party ones (fonts on
  // an offline machine) don't fail the run; our own files must all load.
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  page.on('requestfailed', (r) => { if (r.url().startsWith(base)) errors.push(`failed to load ${r.url()}`); });
  page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

  await page.goto(base);
  await page.waitForSelector('#line:not([disabled])', { timeout: 15000 });

  const run = async (line) => { await page.fill('#line', line); await page.press('#line', 'Enter'); };
  const progress = () => page.textContent('#progress-label');
  const lastLog = async (n = 1) => page.$$eval('#log > div', (d, k) => d.slice(-k).map((x) => x.textContent), n);

  // --- Real emulator semantics through the UI ------------------------------
  await page.click('.example >> nth=0');
  check('example click pastes without running', (await page.inputValue('#line')) === 'ADDI x1, zero, 100');
  await page.press('#line', 'Enter');
  check('step 1 completes', (await progress()) === '1 / 6 complete', await progress());
  check('delta line matches CLI format',
    (await lastLog(2))[0] === 'x1: 0 → 100, PC: 0x00000000 → 0x00000004', (await lastLog(2))[0]);

  await run('ADDD x1, x2, x3');
  check('unknown instruction shows suggestion', (await lastLog())[0].includes("Did you mean 'ADD or ADDI'"), (await lastLog())[0]);

  // --- Play through lessons 2-6 --------------------------------------------
  const solutions = [
    ['ADDI x1, zero, 20', 'ADDI x2, zero, 22', 'ADD x3, x1, x2'],
    ['ADDI x5, zero, 1', '/p', '/n'],
    ['ADDI x1, zero, 5', 'SLLI x2, x1, 4'],
    ['LUI x1, 0x12345', 'ADDI x1, x1, 0x678'],
    ['LI x1, 0x100', 'LI x2, 0x11223344', 'SW x2, 0(x1)', 'LW x3, 0(x1)'],
  ];
  for (const [i, lines] of solutions.entries()) {
    await page.click('#next-step');
    for (const line of lines) await run(line);
    check(`step ${i + 2} completes`, (await progress()) === `${i + 2} / 6 complete`, await progress());
  }

  await run('/memory 0x100');
  check('memory is little-endian', (await lastLog())[0].includes('0x00000100 44 33 22 11'));

  // LI is one history step in the real emulator
  await run('/reset');
  await run('LI x9, 0x12345678');
  check('LI is one history entry', (await page.textContent('#history')) === 'History 1 / 1', await page.textContent('#history'));
  await run('/p');
  check('one /p steps back over all of LI', (await lastLog())[0].includes('x9: 305419896 → 0'), (await lastLog())[0]);

  // Edge cases that used to panic must now be errors, and the REPL keeps working
  await run('LI x1, 1048574');
  await run('LW x2, 0(x1)');
  check('load straddling end of memory is an error', (await lastLog(2)).some((l) => l.includes('out of bounds')));
  await run('ADDI x3, zero, 3');
  check('REPL still works after a fault', (await lastLog())[0].startsWith('x3: 0 → 3'), (await lastLog())[0]);

  // JAL offsets are byte offsets
  await run('/reset');
  await run('JAL x1, 8');
  check('JAL x1, 8 jumps to 8', (await page.textContent('#prompt-pc')) === '[0x00000008]>', await page.textContent('#prompt-pc'));

  // --- History timeline scrubber ---------------------------------------------
  await run('/reset');
  check('scrubber is disabled with no history', await page.isDisabled('#scrubber'));
  for (const line of ['ADDI x1, zero, 1', 'ADDI x1, zero, 2', 'ADDI x2, zero, 5']) await run(line);
  await page.focus('#scrubber');
  await page.keyboard.press('Home'); // jump to the start in one move
  check('scrubber Home goes to the start', (await page.textContent('#history')) === 'History 0 / 3', await page.textContent('#history'));
  check('scrubber logs the net change once',
    (await lastLog())[0] === 'Moved to 0 / 3: x2: 5 → 0, x1: 2 → 0, PC: 0x0000000c → 0x00000000', (await lastLog())[0]);
  const highlighted = () => page.$$eval('.register-row.changed .reg', (r) => r.map((e) => e.textContent).sort().join(' '));
  check('scrubber highlights every register in the net change', (await highlighted()) === 'x1 x2', await highlighted());
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check('scrubber arrow keys step forward', (await page.$eval('#scrubber', (s) => s.getAttribute('aria-valuetext'))) === '2 of 3');
  check('scrubber restores state', (await lastLog())[0] === 'Moved to 2 / 3: x1: 1 → 2, PC: 0x00000004 → 0x00000008', (await lastLog())[0]);
  await run('ADDI x3, zero, 3');
  check('running after scrubbing back discards the steps ahead', (await page.textContent('#history')) === 'History 3 / 3', await page.textContent('#history'));

  // --- Memory panel ------------------------------------------------------------
  await page.focus('#tab-registers');
  await page.keyboard.press('ArrowRight');
  check('memory tab opens from the keyboard',
    (await page.getAttribute('#tab-memory', 'aria-selected')) === 'true' && !(await page.isVisible('#registers')));
  await run('LI x1, 0x200');
  await run('LI x2, 0x11223344');
  await run('SW x2, 4(x1)');
  const memState = () => page.evaluate(() => ({
    first: document.querySelector('.memory-row .addr')?.textContent,
    changed: [...document.querySelectorAll('.byte.changed')].map((e) => e.firstChild?.textContent).join(' '),
  }));
  let mem = await memState();
  check('memory view follows the last write', mem.first === '0x000001e8' && mem.changed === '44 33 22 11', JSON.stringify(mem));
  await page.fill('#mem-addr', '0x40');
  await page.press('#mem-addr', 'Enter');
  mem = await memState();
  check('memory address field pins the view', mem.first === '0x00000028', JSON.stringify(mem));
  await page.fill('#mem-addr', 'nope');
  await page.press('#mem-addr', 'Enter');
  check('invalid memory address is flagged', (await page.getAttribute('#mem-addr', 'aria-invalid')) === 'true');
  await page.fill('#mem-addr', '');
  await page.press('#mem-addr', 'Enter');
  await page.click('#tab-registers');

  // --- Share by URL ------------------------------------------------------------
  await page.click('#btn-share');
  await page.waitForFunction(() => document.querySelector('#log > div:last-child')?.textContent?.includes('http'));
  const shareLine = (await lastLog())[0];
  const url = shareLine.slice(shareLine.indexOf('http'));
  check('share prints a replay link', url.startsWith(base) && url.includes('#step=6') && url.includes('run='), shareLine);
  const here = { pc: await page.textContent('#prompt-pc'), history: await page.textContent('#history') };
  const other = await browser.newPage({ viewport: { width: 1280, height: 860 } }); // fresh storage
  other.on('pageerror', (e) => errors.push(`shared page: ${e.message}`));
  await other.goto(url);
  await other.waitForSelector('#line:not([disabled])');
  const there = { pc: await other.textContent('#prompt-pc'), history: await other.textContent('#history') };
  check('shared link reproduces the session', JSON.stringify(here) === JSON.stringify(there), `${JSON.stringify(here)} vs ${JSON.stringify(there)}`);
  check('shared link opens the same step', (await other.textContent('#step-label')) === 'Step 06 of 06');
  check('replayed lines complete no challenges', (await other.textContent('#progress-label')) === '0 / 6 complete');
  check('shared link is removed from the address bar', (await other.evaluate(() => location.hash)) === '');
  await other.close();

  // --- Layout ---------------------------------------------------------------
  const panes = () => page.evaluate(() => [...document.querySelectorAll('.lesson-pane, .repl-pane')]
    .map((e) => Math.round(e.getBoundingClientRect().width)));
  const before = await panes();
  await run('/regs');
  await run('/m');
  check('wide output does not resize panes', JSON.stringify(before) === JSON.stringify(await panes()));
  await page.setViewportSize({ width: 390, height: 844 });
  check('no horizontal scroll at 390px', (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);

  // --- Persistence ------------------------------------------------------------
  await page.reload();
  await page.waitForSelector('#line:not([disabled])');
  check('progress survives reload', (await progress()) === '6 / 6 complete', await progress());

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
