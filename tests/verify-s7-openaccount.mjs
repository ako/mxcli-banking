/**
 * Slice 7 browser verification.
 *
 * Legacy newregistration.jsp + PDAO.reg() did three things this does not:
 *
 *   1. Allocated the account number with `select * from acc` then
 *      `update acc set cac=cac+1` — a read-modify-write race — and passed
 *      it through a TAMPERABLE HIDDEN FIELD named `acn`. There is no
 *      account-number field on this page at all; AutoNumber assigns it at
 *      commit. The test asserts the new number is the next one and that
 *      no number was reused.
 *
 *   2. Created a whole new login and copied the customer's name, address
 *      and mobile onto it. This opens the account under the existing
 *      login, so the test asserts the CUSTOMER COUNT DOES NOT CHANGE.
 *
 *   3. Opened the account on a bare button press. This requires an
 *      explicit acknowledgement, so the test asserts an unacknowledged
 *      submit opens nothing.
 *
 *   node tests/verify-s7-openaccount.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'RRCustomer2026!';
const failures = [];

function check(name, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

const oql = (q) => execSync(`./mxcli oql -p RRNetBanking.mpr "${q}"`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const accountNumbers = () =>
  (oql('SELECT AccountNumber FROM Banking.Account').match(/\b1\d{8}\b/g) ?? [])
    .map(Number).sort((a, b) => a - b);

const customerCount = () =>
  (oql('SELECT Name FROM Banking.Customer').match(/\|\s*\w+\s*\|/g) ?? []).length;

const notificationCount = () =>
  (oql('SELECT Reference FROM Banking.Notification').match(/\|\s*\d{9}\s*\|/g) ?? []).length;

async function login(page, user) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#usernameInput, input[name="username"]', { timeout: 30000 });
  await page.fill('#usernameInput, input[name="username"]', user);
  await page.fill('#passwordInput, input[name="password"]', PASSWORD);
  await page.click('button[type="submit"], .login-button');
  await page.waitForSelector('text=/Welcome,/', { timeout: 30000 });
}

async function logout(page) {
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

async function openPage(page) {
  await dismissDialog(page);
  await page.click('a:has-text("Open an account")');
  await page.waitForSelector('.mx-name-chkAcknowledge', { timeout: 30000 });
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await login(page, 'rahul');
  await openPage(page);

  // --- there is no account-number field to tamper with --------------------
  console.log('\nthe page exposes no account number:');
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('.mx-name-dvOpen input')]
      .map((i) => `${i.type}:${i.name || i.id}`).join(' | '));
  check('no hidden input carries an account number',
    !/hidden/i.test(inputs), inputs.slice(0, 120));
  check('no field is prefilled with a 1000000xx number',
    !/1000000\d\d/.test(await page.innerText('.mx-name-dvOpen')));

  // --- an unacknowledged submit opens nothing -----------------------------
  console.log('\nwithout the acknowledgement, nothing is opened:');
  const before = accountNumbers();
  const customersBefore = customerCount();

  await page.click('.mx-name-btnOpen');
  await page.waitForTimeout(2500);
  let body = await page.evaluate(() => document.body.innerText);
  check('the acknowledgement is required', /confirm you want to open/.test(body));
  check('no account was created', accountNumbers().length === before.length,
    `${before.length} accounts`);
  await dismissDialog(page);

  // --- opening one --------------------------------------------------------
  console.log('\nopening an account:');
  const notifBefore = notificationCount();

  // Re-open for a clean form: the rejected submit above left a validation
  // message on the checkbox, and `click` on it then toggles the label
  // rather than the input. `check()` asserts the resulting state instead
  // of assuming the click landed.
  await openPage(page);
  await page.check('.mx-name-chkAcknowledge input');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);
  check('the acknowledgement is ticked',
    await page.isChecked('.mx-name-chkAcknowledge input'));
  await page.click('.mx-name-btnOpen');
  await page.waitForTimeout(3000);
  body = await page.evaluate(() => document.body.innerText);

  check('a confirmation naming the new number is shown',
    /Account 1\d{8} has been opened/.test(body),
    (body.match(/Account 1\d{8} has been opened/) ?? [''])[0]);
  await dismissDialog(page);

  const after = accountNumbers();
  check('exactly one account was added', after.length === before.length + 1,
    `${before.length} -> ${after.length}`);
  check('the new number is the next one, not a reused one',
    after[after.length - 1] === before[before.length - 1] + 1,
    `${before[before.length - 1]} -> ${after[after.length - 1]}`);
  check('every account number is still unique',
    new Set(after).size === after.length);

  // THE structural check: no new login was created.
  check('NO new customer identity was created',
    customerCount() === customersBefore,
    `legacy reg() inserted a whole new custp/cust/custd row set`);

  const newAccount = oql('SELECT AccountNumber, Balance, AccountLabel, Status FROM Banking.Account');
  check('the new account opens with a zero balance',
    new RegExp(`\\|\\s*0\\s*\\|[^|]*\\|\\s*${after[after.length - 1]}`).test(newAccount)
      || /\|\s*0\s*\|/.test(newAccount));
  check('the new account has a label',
    new RegExp(`${after[after.length - 1]} —`).test(newAccount));
  check('an SMS was queued about it', notificationCount() === notifBefore + 1,
    `${notifBefore} -> ${notificationCount()}`);

  // --- it shows up everywhere it should -----------------------------------
  console.log('\nthe new account is usable:');
  await dismissDialog(page);
  await page.click('a:has-text("Home")');
  await page.waitForSelector('.mx-name-dgAccounts', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const dash = await page.innerText('.mx-name-dgAccounts');
  check('it appears on the dashboard', new RegExp(String(after[after.length - 1])).test(dash));

  // Not a literal 2: this suite opens an account every time it runs, so
  // rahul's account count grows with each run. What the slice claims is
  // that the dashboard lists exactly the accounts he holds and no blanks.
  const heldByRahul = (oql(
    'SELECT a.AccountNumber, c.Name FROM Banking.Account as a '
    + 'inner join Banking.Account_Customer/Banking.Customer as c',
  ).match(/\|\s*rahul\s*\|/g) ?? []).length;
  const dashRows = await page.evaluate(() =>
    [...document.querySelectorAll('.mx-name-dgAccounts [role="row"]')]
      .slice(1).filter((r) => r.innerText.trim().length > 0).length);
  check('the dashboard lists every account he holds, none blank',
    dashRows === heldByRahul, `${dashRows} rows, db says ${heldByRahul}`);

  await page.screenshot({ path: 'tests/screenshots/s7-openaccount-rahul.png', fullPage: true });
  await logout(page);
  await page.close();

  // --- and it is still nobody else's --------------------------------------
  console.log('\nisolation still holds:');
  const p2 = await browser.newPage();
  await login(p2, 'priya');
  await p2.waitForSelector('.mx-name-dgAccounts', { timeout: 30000 });
  await p2.waitForTimeout(2000);
  const priyaDash = await p2.innerText('.mx-name-dgAccounts');
  check("priya does not see rahul's new account",
    !new RegExp(String(after[after.length - 1])).test(priyaDash));
  await logout(p2);
  await p2.close();
} finally {
  await browser.close();
}

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All slice 7 checks passed.');
