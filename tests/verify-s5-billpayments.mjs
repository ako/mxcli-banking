/**
 * Slice 5 browser verification.
 *
 * The legacy bill payment was broken in a way the UI never showed. Its
 * company dropdown had no `name` attribute, so the browser never
 * submitted it, and its inner <form action="form_action.asp"> shadowed
 * the outer one. The servlet received an amount and nothing else, and
 * uppay() debited the account with no record of where the money went.
 *
 * So the headline check here is simply: the biller REACHES THE SERVER and
 * ends up on the payment record. Then the same money-invariant checks as
 * the transfer slice — a bill payment debits exactly one account and
 * writes exactly one ledger line, and a rejected one moves nothing.
 *
 *   node tests/verify-s5-billpayments.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'RRCustomer2026!';
const RAHUL_ACCOUNT = '100000001';
const failures = [];

function check(name, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

function oql(query) {
  return execSync(`./mxcli oql -p RRNetBanking.mpr "${query}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function balances() {
  const map = {};
  for (const line of oql('SELECT AccountNumber, Balance FROM Banking.Account').split('\n')) {
    const m = line.match(/\|\s*([\d.]+)\s*\|\s*(\d{9})\s*\|/);
    if (m) map[m[2]] = parseFloat(m[1]);
  }
  return map;
}

const ledgerCount = () =>
  (oql('SELECT Reference FROM Banking.Transaction').match(/\|\s*\d{9}\s*\|/g) ?? []).length;

const paymentRows = () => oql(
  'SELECT Reference, Amount, ConsumerNumber, BillerName FROM Banking.BillPayment');

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

async function dismissDialog(page) {
  const ok = page.locator('.mx-dialog button, .modal button').filter({ hasText: /^OK$/ });
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(700);
  }
}

async function openBillPage(page) {
  await dismissDialog(page);
  await page.click('a:has-text("Bill payment")');
  await page.waitForSelector('.mx-name-cbBiller', { timeout: 30000 });
  await page.waitForTimeout(1500);
}

async function selectBiller(page, name) {
  await page.click('.mx-name-cbBiller .widget-combobox-input-container');
  await page.waitForTimeout(700);
  await page.click(`.widget-combobox-menu li:has-text("${name}")`);
  await page.waitForTimeout(700);
}

async function pay(page, { consumer, amount }) {
  if (consumer !== undefined) await page.fill('.mx-name-txtConsumer input', consumer);
  if (amount !== undefined) await page.fill('.mx-name-txtAmount input', amount);
  await page.click('.mx-name-btnPay button, .mx-name-btnPay');
  await page.waitForTimeout(3000);
  return page.evaluate(() => document.body.innerText);
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await login(page, 'rahul');
  await openBillPage(page);

  // --- the billers actually reach the browser -----------------------------
  console.log('\nthe biller list is real reference data:');
  await page.click('.mx-name-cbBiller .widget-combobox-input-container');
  // Wait for the options themselves. Reading innerText of the menu
  // container right after the click returns before the list is populated.
  await page.waitForSelector('.widget-combobox-menu li', { timeout: 15000 });
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('.widget-combobox-menu li')].map((li) => li.innerText).join('|'));
  check('the two legacy hardcoded companies are listed',
    /Reliance Comm\./.test(options) && /TATA Indicom/.test(options), options.slice(0, 90));
  check('the other categories from the prose are listed',
    /Electricity Board/.test(options) && /Life Insurance/.test(options));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // --- a good payment -----------------------------------------------------
  console.log('\nrahul pays a 1500 electricity bill:');
  const before = balances();
  const linesBefore = ledgerCount();
  const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);

  await selectBiller(page, 'Electricity Board');
  let body = await pay(page, { consumer: 'MSEB-77120', amount: '1500' });

  check('a confirmation with a reference is shown', /Bill paid\. Reference \d+/.test(body));
  await dismissDialog(page);

  const after = balances();
  const totalAfter = Object.values(after).reduce((a, b) => a + b, 0);

  check('the payer was debited', after[RAHUL_ACCOUNT] === before[RAHUL_ACCOUNT] - 1500,
    `${before[RAHUL_ACCOUNT]} -> ${after[RAHUL_ACCOUNT]}`);
  check('no other account moved',
    Object.keys(before).filter((k) => k !== RAHUL_ACCOUNT)
      .every((k) => before[k] === after[k]));
  check('money left the bank, as a bill payment should', totalAfter === totalBefore - 1500,
    `total ${totalBefore} -> ${totalAfter}`);
  check('exactly one ledger line was written', ledgerCount() === linesBefore + 1,
    `${linesBefore} -> ${ledgerCount()}`);

  // THE headline check: the legacy dropdown never reached the server.
  const rows = paymentRows();
  check('THE BILLER REACHED THE SERVER and is on the record',
    /Maharashtra State Electricity Board/.test(rows),
    'legacy: <select> had no name attribute, so it never posted');
  check('the consumer number is on the record', /MSEB-77120/.test(rows));

  // --- rejections ---------------------------------------------------------
  console.log('\nrejections leave the account untouched:');
  await openBillPage(page);
  const beforeReject = balances();
  const linesBeforeReject = ledgerCount();

  await selectBiller(page, 'Reliance Comm.');
  body = await pay(page, { consumer: 'RC-1', amount: String(beforeReject[RAHUL_ACCOUNT] + 500) });
  check('more than the balance is rejected', /more than the balance available/.test(body));
  check('no money moved', JSON.stringify(balances()) === JSON.stringify(beforeReject));
  await dismissDialog(page);

  await openBillPage(page);
  await selectBiller(page, 'Reliance Comm.');
  body = await pay(page, { consumer: 'RC-1', amount: '0' });
  check('a zero amount is rejected', /must be greater than 0/.test(body),
    (body.match(/(must be greater than 0|more than the balance|Enter an amount)/) ?? ['no message'])[0]);
  await dismissDialog(page);

  await openBillPage(page);
  await selectBiller(page, 'TATA Indicom');
  body = await pay(page, { consumer: '', amount: '100' });
  check('a missing consumer number is rejected', /consumer or account number/.test(body));
  await dismissDialog(page);

  check('no ledger line was written by any rejection', ledgerCount() === linesBeforeReject,
    `${linesBeforeReject} -> ${ledgerCount()}`);

  await page.screenshot({ path: 'tests/screenshots/s5-billpayment-rahul.png', fullPage: true });

  // --- it lands on the statement -----------------------------------------
  console.log('\nthe payment reached the statement:');
  await dismissDialog(page);
  await page.click('a:has-text("Account statement")');
  await page.waitForSelector('.mx-name-dgStatement', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const grid = await page.innerText('.mx-name-dgStatement');
  check('the statement shows the bill payment by company name',
    /Bill payment - Maharashtra State Electricity Board/.test(grid));

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
console.log('All slice 5 checks passed.');
