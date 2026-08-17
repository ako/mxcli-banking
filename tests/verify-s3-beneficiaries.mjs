/**
 * Slice 3 browser verification.
 *
 * The headline check is the last one. The legacy system removed a payee with
 *
 *   delete from bene where tacc = <request parameter>
 *
 * and no owner clause, so removing YOUR payee removed that payee for every
 * customer in the bank. Here rahul and priya both register meera's account,
 * rahul removes his, and priya's must survive.
 *
 * Also checks the five validation rules that the legacy app enforced only
 * in client-side JavaScript — and then trusted a hidden form field to say
 * the script had run.
 *
 * Assumes the seeded accounts 100000001 (rahul), 100000002 (priya) and
 * 100000003 (meera). Re-runnable: it clears rahul's and priya's payees
 * through the UI at the start.
 *
 *   node tests/verify-s3-beneficiaries.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'RRCustomer2026!';
const MEERA_ACCOUNT = '100000003';
const failures = [];

function check(name, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

async function login(page, user) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#usernameInput, input[name="username"]', { timeout: 30000 });
  await page.fill('#usernameInput, input[name="username"]', user);
  await page.fill('#passwordInput, input[name="password"]', PASSWORD);
  await page.click('button[type="submit"], .login-button');
  await page.waitForSelector('text=/Welcome,/', { timeout: 30000 });
}

async function logout(page) {
  // mx.logout(), not GET /logout. There is no /logout route — the runtime
  // answers "404 - file not found for file: logout" and the session stays
  // alive, which is how several suites quietly exhausted the trial
  // licence's concurrent-session cap and started failing at the login form.
  await page.evaluate(() => {
    if (window.mx && typeof window.mx.logout === 'function') window.mx.logout();
  }).catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Dismiss a Mendix Show Message modal if one is up.
 *
 * Show Message is BLOCKING by default and MDL cannot turn that off, so a
 * failure message puts a modal over the page that swallows the next click.
 * Only failures show one here, but the tests deliberately trigger those.
 */
async function dismissDialog(page) {
  const ok = page.locator('.mx-dialog button, .modal button').filter({ hasText: /^OK$/ });
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(600);
  }
}

/**
 * Re-open the payee list from the menu.
 *
 * Always re-navigates rather than trusting the grid to refresh in place:
 * the grid's datasource is a microflow, and Mendix has no dependency
 * information that would tell it to re-run after a delete.
 */
async function openBeneficiaries(page) {
  await dismissDialog(page);
  await page.click('a:has-text("Home")');
  await page.waitForTimeout(800);
  await page.click('a:has-text("Beneficiaries")');
  await page.waitForSelector('.mx-name-dgBeneficiaries', { timeout: 30000 });
  await page.waitForTimeout(1800);
}

async function gridText(page) {
  return page.innerText('.mx-name-dgBeneficiaries');
}

async function payeeRowCount(page) {
  return page.evaluate(() => {
    const g = document.querySelector('.mx-name-dgBeneficiaries');
    if (!g) return -1;
    return [...g.querySelectorAll('[role="row"]')]
      .slice(1)
      .filter((r) => r.innerText.trim().length > 0).length;
  });
}

/** Fill and submit the add-payee form. Returns the validation text shown. */
async function addPayee(page, { account, nickname, limit }) {
  await page.click('.mx-name-btnAdd button, .mx-name-btnAdd');
  await page.waitForSelector('.mx-name-txtTarget input', { timeout: 30000 });
  if (account !== undefined) await page.fill('.mx-name-txtTarget input', account);
  if (nickname !== undefined) await page.fill('.mx-name-txtNickname input', nickname);
  if (limit !== undefined) await page.fill('.mx-name-txtLimit input', limit);
  await page.click('.mx-name-btnSave button, .mx-name-btnSave');
  await page.waitForTimeout(2500);
  return page.evaluate(() => document.body.innerText);
}

/** Close the form if it is still open after a rejected save. */
async function closeFormIfOpen(page) {
  await dismissDialog(page);
  const open = await page.locator('.mx-name-btnCancel').count();
  if (open > 0) {
    await page.click('.mx-name-btnCancel button, .mx-name-btnCancel');
    await page.waitForTimeout(1200);
  }
}

/** Remove every payee currently listed, so the run starts clean. */
async function clearPayees(page) {
  for (let i = 0; i < 10; i++) {
    const n = await payeeRowCount(page);
    if (n <= 0) break;
    await page.click('.mx-name-btnRemove button, .mx-name-btnRemove');
    await page.waitForTimeout(1500);
    await openBeneficiaries(page);
  }
}

const browser = await chromium.launch({ headless: true });

try {
  // --- start from a known state ------------------------------------------
  for (const user of ['rahul', 'priya']) {
    const p = await browser.newPage();
    await login(p, user);
    await openBeneficiaries(p);
    await clearPayees(p);
    await logout(p);
    await p.close();
  }

  // --- validation ---------------------------------------------------------
  console.log('\nrahul — validation:');
  let page = await browser.newPage();
  await login(page, 'rahul');
  await openBeneficiaries(page);

  let body = await addPayee(page, { account: '999999999', nickname: 'Ghost', limit: '1000' });
  check('a non-existent account number is rejected', /No account with that number exists/.test(body));
  await closeFormIfOpen(page);

  body = await addPayee(page, { account: '100000001', nickname: 'Myself', limit: '1000' });
  check('your own account is rejected', /That is your own account/.test(body));
  await closeFormIfOpen(page);

  body = await addPayee(page, { account: MEERA_ACCOUNT, nickname: 'Meera', limit: '0' });
  check('a zero transfer limit is rejected', /must be greater than 0/.test(body));
  await closeFormIfOpen(page);

  body = await addPayee(page, { account: MEERA_ACCOUNT, nickname: 'Meera', limit: '' });
  check('a missing transfer limit is rejected', /Enter a transfer limit/.test(body));
  await closeFormIfOpen(page);

  check('nothing invalid was saved', (await payeeRowCount(page)) === 0,
    `${await payeeRowCount(page)} payees`);

  // --- the happy path -----------------------------------------------------
  console.log('\nrahul — add and edit:');
  await addPayee(page, { account: MEERA_ACCOUNT, nickname: 'Meera rent', limit: '5000' });
  await openBeneficiaries(page);

  let grid = await gridText(page);
  check('the payee was added', /Meera rent/.test(grid));
  check('the payee account is shown by label', new RegExp(MEERA_ACCOUNT).test(grid));
  check('the transfer limit is shown', /5,?000/.test(grid));

  body = await addPayee(page, { account: MEERA_ACCOUNT, nickname: 'Meera again', limit: '2000' });
  check('a duplicate payee is rejected', /already registered as a payee/.test(body));
  await closeFormIfOpen(page);
  await openBeneficiaries(page);
  check('the duplicate was not saved', (await payeeRowCount(page)) === 1,
    `${await payeeRowCount(page)} payees`);

  // Edit the limit.
  await page.click('.mx-name-btnEdit button, .mx-name-btnEdit');
  await page.waitForSelector('.mx-name-txtLimit input', { timeout: 30000 });
  await page.fill('.mx-name-txtLimit input', '7500');
  await page.click('.mx-name-btnSave button, .mx-name-btnSave');
  await page.waitForTimeout(2500);
  await openBeneficiaries(page);
  grid = await gridText(page);
  check('the edited limit was saved', /7,?500/.test(grid));

  await page.screenshot({ path: 'tests/screenshots/s3-beneficiaries-rahul.png', fullPage: true });
  await logout(page);
  await page.close();

  // --- priya registers the SAME payee -------------------------------------
  console.log('\npriya — registers the same payee:');
  page = await browser.newPage();
  await login(page, 'priya');
  await openBeneficiaries(page);
  await addPayee(page, { account: MEERA_ACCOUNT, nickname: 'Meera school fees', limit: '9000' });
  await openBeneficiaries(page);

  grid = await gridText(page);
  check('priya can register the same target account', /Meera school fees/.test(grid));
  check("priya does not see rahul's payee", !/Meera rent/.test(grid));
  check('priya sees exactly one payee', (await payeeRowCount(page)) === 1,
    `${await payeeRowCount(page)} payees`);

  await logout(page);
  await page.close();

  // --- THE regression check ----------------------------------------------
  console.log('\nrahul removes his payee — the legacy cross-customer delete:');
  page = await browser.newPage();
  await login(page, 'rahul');
  await openBeneficiaries(page);
  await clearPayees(page);
  await openBeneficiaries(page);
  check("rahul's payee list is now empty", (await payeeRowCount(page)) === 0,
    `${await payeeRowCount(page)} payees`);
  await logout(page);
  await page.close();

  page = await browser.newPage();
  await login(page, 'priya');
  await openBeneficiaries(page);
  grid = await gridText(page);
  check(
    "priya's payee SURVIVED rahul's removal",
    /Meera school fees/.test(grid) && (await payeeRowCount(page)) === 1,
    'legacy: delete from bene where tacc=? removed it for everyone',
  );
  await logout(page);
  await page.close();
} finally {
  await browser.close();
}

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All slice 3 checks passed.');
