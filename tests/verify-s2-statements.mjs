/**
 * Slice 2 browser verification.
 *
 * Checks what the slice claims:
 *   1. The account statement shows the seeded ledger over its default
 *      30-day range, with the running balance the legacy schema could not
 *      produce.
 *   2. Narrowing the date range actually filters — this is the feature
 *      afterenquery.jsp implemented by concatenating two request
 *      parameters into SQL.
 *   3. The mini statement is bounded (the legacy one was not: ministat.jsp
 *      rendered whatever the session happened to hold).
 *   4. A customer sees only their own ledger. rahul holds references
 *      500000001-3, priya 500000004-6.
 *
 * Run with the app already up:
 *   node tests/verify-s2-statements.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const failures = [];

function check(name, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

async function login(page, user, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"], #usernameInput', { timeout: 30000 });
  await page.fill('input[name="username"], #usernameInput', user);
  await page.fill('input[name="password"], #passwordInput', password);
  await page.click('button[type="submit"], .login-button');
  await page.waitForSelector('text=/Welcome,/', { timeout: 30000 });
}

/**
 * End the Mendix session, not just the browser page.
 *
 * The developer/trial license caps concurrent sessions, and closing a page
 * leaves its server-side session alive until it times out. Repeated test
 * runs then fail at the login form with "Sign in failed", while the
 * runtime log shows "Maximum number of sessions exceeded! (You are
 * currently using a trial license)".
 */
async function logout(page) {
  await page.goto(`${BASE}/logout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
}

async function openMenuItem(page, label) {
  await page.click(`.mx-navigationtree a:has-text("${label}"), a:has-text("${label}")`);
}

/**
 * Rows in a Mendix data grid, split into rendered-with-content and total.
 *
 * The split matters. A datasource microflow that retrieves without an
 * ownership constraint returns other customers' objects; entity access
 * then blanks their attributes, so they render as EMPTY rows while the
 * pager still counts them. Comparing "rows with text" against "total rows"
 * is what exposes that — checking only for absent account numbers does
 * not, because a blanked row has no numbers in it either.
 */
async function gridRows(page, gridClass) {
  return page.evaluate((cls) => {
    const grid = document.querySelector(cls);
    if (!grid) return { total: -1, withContent: -1, pager: '' };
    const rows = [...grid.querySelectorAll('[role="row"]')];
    // Row 0 is the header.
    const body = rows.slice(1);
    return {
      total: body.length,
      withContent: body.filter((r) => r.innerText.trim().length > 0).length,
      pager: (grid.innerText.match(/showing \d+ to \d+ of \d+/i) ?? [''])[0],
    };
  }, gridClass);
}

const browser = await chromium.launch({ headless: true });

try {
  console.log('\nrahul — account statement:');
  const page = await browser.newPage();
  await login(page, 'rahul', 'RRCustomer2026!');

  await openMenuItem(page, 'Account statement');
  await page.waitForSelector('.mx-name-dgStatement', { timeout: 30000 });
  await page.waitForFunction(
    () => /50000000\d/.test(document.querySelector('.mx-name-dgStatement')?.innerText ?? ''),
    null,
    { timeout: 30000 },
  );

  let grid = await page.innerText('.mx-name-dgStatement');

  check('opening deposit is listed', /Opening deposit/.test(grid));
  check('bill payment is listed', /Reliance Comm\./.test(grid));
  check('transfer is listed', /Transfer to beneficiary/.test(grid));
  check('running balance is shown', /30,?000/.test(grid) && /27,?000/.test(grid) && /25,?000/.test(grid));
  check('account picker uses the account label',
    /100000001/.test(await page.innerText('.mx-name-cbAccount')));

  check(
    "priya's ledger is NOT visible to rahul",
    !/50000000[456]/.test(grid),
    'XPath traverses Transaction -> Account -> Customer',
  );

  await page.screenshot({ path: 'tests/screenshots/s2-statement-rahul.png', fullPage: true });

  // --- date range actually filters ---------------------------------------
  console.log('\nrahul — date range filtering:');
  const rowsBefore = (await gridRows(page, '.mx-name-dgStatement')).withContent;

  // Move "From" to 7 days ago: that excludes the opening deposit (21 days)
  // and the bill payment (14 days), leaving only the transfer (3 days).
  const from = new Date(Date.now() - 7 * 86400000);
  const formatted = `${from.getMonth() + 1}/${from.getDate()}/${from.getFullYear()}`;

  const fromInput = page.locator('.mx-name-dpFrom input').first();
  await fromInput.fill('');
  await fromInput.fill(formatted);
  await fromInput.press('Enter');

  // The grid's datasource does not re-run on input change — the button
  // refreshes the filter object in the client, which is what re-runs it.
  await page.click('.mx-name-btnShow button, .mx-name-btnShow');
  await page.waitForFunction(
    () => !/Opening deposit/.test(document.querySelector('.mx-name-dgStatement')?.innerText ?? ''),
    null,
    { timeout: 30000 },
  );

  grid = await page.innerText('.mx-name-dgStatement');
  const rowsAfter = (await gridRows(page, '.mx-name-dgStatement')).withContent;

  check('narrowing the range drops the opening deposit', !/Opening deposit/.test(grid));
  check('narrowing the range drops the bill payment', !/Reliance Comm\./.test(grid));
  check('the recent transfer survives the filter', /Transfer to beneficiary/.test(grid));
  check('row count fell', rowsAfter < rowsBefore, `${rowsBefore} -> ${rowsAfter}`);

  // --- mini statement -----------------------------------------------------
  console.log('\nrahul — mini statement:');
  await openMenuItem(page, 'Mini statement');
  await page.waitForSelector('.mx-name-dgMini', { timeout: 30000 });
  await page.waitForFunction(
    () => /Opening deposit/.test(document.querySelector('.mx-name-dgMini')?.innerText ?? ''),
    null,
    { timeout: 30000 },
  );

  const mini = await page.innerText('.mx-name-dgMini');
  const miniRows = await gridRows(page, '.mx-name-dgMini');

  check('mini statement shows the ledger', /Opening deposit/.test(mini));
  check('mini statement is bounded to 5 lines', miniRows.total <= 5, `${miniRows.total} rows`);

  // rahul owns exactly 3 ledger lines. Anything more means the retrieve
  // reached into another customer's ledger, even if it renders blank.
  check(
    'mini statement retrieved ONLY rahul\'s 3 lines',
    miniRows.total === 3 && miniRows.withContent === 3,
    `${miniRows.withContent} with content / ${miniRows.total} total ${miniRows.pager}`,
  );

  await logout(page);
  await page.close();

  // --- the other customer -------------------------------------------------
  console.log('\npriya — isolation:');
  const page2 = await browser.newPage();
  await login(page2, 'priya', 'RRCustomer2026!');
  await openMenuItem(page2, 'Account statement');
  await page2.waitForSelector('.mx-name-dgStatement', { timeout: 30000 });
  await page2.waitForFunction(
    () => /50000000\d/.test(document.querySelector('.mx-name-dgStatement')?.innerText ?? ''),
    null,
    { timeout: 30000 },
  );

  const grid2 = await page2.innerText('.mx-name-dgStatement');
  const rows2 = await gridRows(page2, '.mx-name-dgStatement');
  check("rahul's ledger is NOT visible to priya", !/50000000[123]/.test(grid2));
  check('priya sees her own ledger', /50000000[456]/.test(grid2));
  check(
    'no blank rows leaked into priya\'s statement',
    rows2.total === rows2.withContent && rows2.total === 3,
    `${rows2.withContent} with content / ${rows2.total} total ${rows2.pager}`,
  );

  await logout(page2);
  await page2.close();
} finally {
  await browser.close();
}

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All slice 2 checks passed.');
