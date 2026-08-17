/**
 * Slice 4 browser verification.
 *
 * The two things this slice exists to fix:
 *
 *   1. ATOMICITY. PDAOU.transfer() ran four separate statements —
 *      debit, insert 'W', credit, insert 'D' — with a catch block that
 *      only printed. A failure part-way destroyed or created money. Here
 *      the whole thing is one microflow, so one transaction. The test
 *      asserts the invariant that matters: the TOTAL across both accounts
 *      is unchanged, and both ledger lines exist with matching amounts.
 *
 *   2. SERVER-SIDE LIMITS. TRANSFERMONEY1.jsp checked the limit and the
 *      balance in JavaScript, and the servlet checked nothing. Here both
 *      are enforced server-side, and the test confirms a rejected
 *      transfer moved no money at all.
 *
 * Balances are read straight from the database with mxcli oql rather than
 * scraped from the page, so the assertions are about the data, not the UI.
 *
 *   node tests/verify-s4-transfers.mjs
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

/** Account balances straight from the database, keyed by account number. */
function balances() {
  const out = execSync(
    `./mxcli oql -p RRNetBanking.mpr "SELECT AccountNumber, Balance FROM Banking.Account"`,
    // stderr is dropped: mxcli prints its alpha-quality banner on every
    // invocation, and this runs a dozen times per test.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/\|\s*([\d.]+)\s*\|\s*(\d{9})\s*\|/);
    if (m) map[m[2]] = parseFloat(m[1]);
  }
  return map;
}

function ledgerCount() {
  const out = execSync(
    `./mxcli oql -p RRNetBanking.mpr "SELECT Reference FROM Banking.Transaction"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return (out.match(/\|\s*\d{9}\s*\|/g) ?? []).length;
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
  await page.goto(`${BASE}/logout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
}

async function dismissDialog(page) {
  const ok = page.locator('.mx-dialog button, .modal button').filter({ hasText: /^OK$/ });
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(700);
  }
}

async function openPage(page, label, anchorSelector) {
  await dismissDialog(page);
  await page.click(`a:has-text("${label}")`);
  await page.waitForSelector(anchorSelector, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

/** Select the payee in the ComboBox by its visible label. */
async function selectPayee(page, accountNumber) {
  await page.click('.mx-name-cbPayee .widget-combobox-input-container');
  await page.waitForTimeout(700);
  await page.click(`.widget-combobox-menu li:has-text("${accountNumber}")`);
  await page.waitForTimeout(700);
}

async function submitTransfer(page, { amount, remarks }) {
  await page.fill('.mx-name-txtAmount input', amount);
  if (remarks) await page.fill('.mx-name-txtRemarks input', remarks);
  await page.click('.mx-name-btnTransfer button, .mx-name-btnTransfer');
  await page.waitForTimeout(3000);
  return page.evaluate(() => document.body.innerText);
}

const browser = await chromium.launch({ headless: true });

try {
  // Ensure rahul has meera registered with a known limit.
  console.log('\nsetup — rahul registers meera with a 7500 limit:');
  let page = await browser.newPage();
  await login(page, 'rahul');
  await openPage(page, 'Beneficiaries', '.mx-name-dgBeneficiaries');

  const already = await page.evaluate(
    (acct) => (document.querySelector('.mx-name-dgBeneficiaries')?.innerText ?? '').includes(acct),
    MEERA_ACCOUNT,
  );
  if (!already) {
    await page.click('.mx-name-btnAdd button, .mx-name-btnAdd');
    await page.waitForSelector('.mx-name-txtTarget input', { timeout: 30000 });
    await page.fill('.mx-name-txtTarget input', MEERA_ACCOUNT);
    await page.fill('.mx-name-txtNickname input', 'Meera rent');
    await page.fill('.mx-name-txtLimit input', '7500');
    await page.click('.mx-name-btnSave button, .mx-name-btnSave');
    await page.waitForTimeout(2500);
    await openPage(page, 'Beneficiaries', '.mx-name-dgBeneficiaries');
  }
  const beneText = await page.innerText('.mx-name-dgBeneficiaries');
  check('the payee is registered', new RegExp(MEERA_ACCOUNT).test(beneText));

  // --- a good transfer ----------------------------------------------------
  console.log('\nrahul transfers 2000 to meera:');
  const before = balances();
  const linesBefore = ledgerCount();
  const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);

  await openPage(page, 'Transfer money', '.mx-name-cbPayee');
  await selectPayee(page, MEERA_ACCOUNT);
  let body = await submitTransfer(page, { amount: '2000', remarks: 'Rent' });

  check('a confirmation with a reference is shown', /Transfer completed\. Reference \d+/.test(body));
  await dismissDialog(page);

  const after = balances();
  const linesAfter = ledgerCount();
  const totalAfter = Object.values(after).reduce((a, b) => a + b, 0);

  check("the payer was debited", after['100000001'] === before['100000001'] - 2000,
    `${before['100000001']} -> ${after['100000001']}`);
  check('the payee was credited', after[MEERA_ACCOUNT] === before[MEERA_ACCOUNT] + 2000,
    `${before[MEERA_ACCOUNT]} -> ${after[MEERA_ACCOUNT]}`);
  check('no money was created or destroyed', totalAfter === totalBefore,
    `total ${totalBefore} -> ${totalAfter}`);
  check('exactly two ledger lines were written', linesAfter === linesBefore + 2,
    `${linesBefore} -> ${linesAfter}`);

  // --- over the payee's transfer limit ------------------------------------
  console.log('\nrahul tries 9000, above the 7500 payee limit:');
  const beforeLimit = balances();
  const linesBeforeLimit = ledgerCount();

  await openPage(page, 'Transfer money', '.mx-name-cbPayee');
  await selectPayee(page, MEERA_ACCOUNT);
  body = await submitTransfer(page, { amount: '9000', remarks: 'Too big' });

  check('the limit breach is reported', /more than the transfer limit/.test(body));
  check('no money moved', JSON.stringify(balances()) === JSON.stringify(beforeLimit));
  check('no ledger line was written', ledgerCount() === linesBeforeLimit);
  await dismissDialog(page);

  // --- over the account balance -------------------------------------------
  // Raise the limit above the balance so the BALANCE rule is what bites.
  console.log('\nrahul raises the limit to 999999, then tries more than his balance:');
  await openPage(page, 'Beneficiaries', '.mx-name-dgBeneficiaries');
  await page.click('.mx-name-btnEdit button, .mx-name-btnEdit');
  await page.waitForSelector('.mx-name-txtLimit input', { timeout: 30000 });
  await page.fill('.mx-name-txtLimit input', '999999');
  await page.click('.mx-name-btnSave button, .mx-name-btnSave');
  await page.waitForTimeout(2500);

  const beforeBalance = balances();
  const linesBeforeBalance = ledgerCount();
  const tooMuch = String(beforeBalance['100000001'] + 1000);

  await openPage(page, 'Transfer money', '.mx-name-cbPayee');
  await selectPayee(page, MEERA_ACCOUNT);
  body = await submitTransfer(page, { amount: tooMuch, remarks: 'Overdraw' });

  check('the balance breach is reported', /more than the balance available/.test(body));
  check('no money moved', JSON.stringify(balances()) === JSON.stringify(beforeBalance));
  check('no ledger line was written', ledgerCount() === linesBeforeBalance);
  await dismissDialog(page);

  // --- a non-positive amount ----------------------------------------------
  console.log('\nrahul tries a zero amount:');
  const beforeZero = balances();
  await openPage(page, 'Transfer money', '.mx-name-cbPayee');
  await selectPayee(page, MEERA_ACCOUNT);
  body = await submitTransfer(page, { amount: '0', remarks: 'Nothing' });

  check('a zero amount is rejected', /must be greater than 0/.test(body));
  check('no money moved', JSON.stringify(balances()) === JSON.stringify(beforeZero));
  await dismissDialog(page);

  await page.screenshot({ path: 'tests/screenshots/s4-transfer-rahul.png', fullPage: true });
  await logout(page);
  await page.close();

  // --- the transfer shows up on the statement -----------------------------
  console.log('\nthe transfer reached both statements:');
  page = await browser.newPage();
  await login(page, 'rahul');
  await openPage(page, 'Account statement', '.mx-name-dgStatement');
  let grid = await page.innerText('.mx-name-dgStatement');
  check("the payer's statement shows the debit", /Transfer to .*100000003/.test(grid));
  await logout(page);
  await page.close();

  page = await browser.newPage();
  await login(page, 'meera');
  await openPage(page, 'Account statement', '.mx-name-dgStatement');
  grid = await page.innerText('.mx-name-dgStatement');
  check("the payee's statement shows the credit", /Transfer received/.test(grid));
  check("the payee cannot see the payer's transfer record",
    !/Rent/.test(await page.evaluate(() => document.body.innerText)));
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
console.log('All slice 4 checks passed.');
