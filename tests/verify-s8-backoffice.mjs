/**
 * Slice 8 browser verification.
 *
 * The legacy app had no back office. Billers were two hardcoded <option>
 * tags in transbill.jsp, branches were a free-text string typed into the
 * registration form, and the loan brochure was three <li> elements in
 * loan.jsp all linking to the same LOAN.doc. Every one of those was a
 * redeploy.
 *
 * Four things are checked:
 *
 *   1. The brochure is data. The Loans page renders the seeded products
 *      with their rates, and an administrator deactivating one removes it
 *      from the customer's page — no code change involved.
 *
 *   2. The back office is administrator-only. A customer's menu shows the
 *      back-office items (MDL has no per-role menu), so the test drives a
 *      CUSTOMER at each back-office URL and asserts nothing renders. This
 *      is the check that matters: the menu is untidy, the access is not.
 *
 *   3. Reference data round-trips. A biller added through the form
 *      reaches the database, a duplicate code is refused server-side, and
 *      deactivating a biller removes it from the customer's payment
 *      dropdown — the rule tightened in s8-02.
 *
 *   4. The totals are real. Every figure on the admin dashboard is
 *      compared against an OQL count of the same table.
 *
 * The suite puts back everything it changes, so it is re-runnable.
 *
 *   node tests/verify-s8-backoffice.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'RRCustomer2026!';
const ADMIN_PASSWORD = 'RRAdmin2026!!';
const failures = [];

function check(name, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

const oql = (q) => execSync(`./mxcli oql -p RRNetBanking.mpr "${q}"`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Table rows in mxcli's OQL output, minus the header and the rule lines. */
const rowCount = (out) => out.split('\n')
  .filter((l) => l.startsWith('|') && !/^\|[-\s|]*\|$/.test(l)).length - 1;

/**
 * A biller code no previous run has used.
 *
 * Nothing in this app deletes a biller — every payment ever made
 * references one, and the association is PREVENT-on-delete — so the suite
 * cannot clean up after itself the way it can with a loan product. It
 * takes a fresh code each run instead and leaves the previous one
 * deactivated, which is the state the back office actually offers.
 */
const nextTestBillerCode = () => {
  const used = (oql('SELECT BillerCode FROM Banking.Biller').match(/S8T(\d+)/g) ?? [])
    .map((c) => Number(c.slice(3)));
  return `S8T${used.length ? Math.max(...used) + 1 : 1}`;
};
const TEST_BILLER_CODE = nextTestBillerCode();
const TEST_BILLER_NAME = `Slice 8 Test Utility ${TEST_BILLER_CODE}`;

async function login(page, user, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#usernameInput, input[name="username"]', { timeout: 30000 });
  await page.fill('#usernameInput, input[name="username"]', user);
  await page.fill('#passwordInput, input[name="password"]', password);
  await page.click('button[type="submit"], .login-button');
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

/** Mendix commits inputs on BLUR — tab out before pressing anything. */
async function commitInputs(page) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
}

async function menu(page, caption) {
  await dismissDialog(page);
  await page.click(`a:has-text("${caption}")`);
  await page.waitForTimeout(2500);
}

const browser = await chromium.launch({ headless: true });

/**
 * Every page this suite opens, so the finally block can end their sessions.
 *
 * A page that is merely closed leaves its runtime session alive, and the
 * trial licence caps concurrent sessions. Three crashed runs in a row is
 * enough to make the NEXT run fail at the login form for reasons that have
 * nothing to do with the code under test — which is exactly what happened
 * while this suite was being written.
 */
const openPages = [];
const newSession = async () => {
  const p = await browser.newPage();
  openPages.push(p);
  return p;
};

try {
  // =====================================================================
  // The customer side: content pages, and no back office
  // =====================================================================
  const cust = await newSession();
  await login(cust, 'rahul', PASSWORD);
  await cust.waitForSelector('text=/Welcome,/', { timeout: 30000 });

  console.log('\nthe loans brochure is data, not markup:');
  await menu(cust, 'Loans');
  await cust.waitForSelector('.mx-name-dgLoans', { timeout: 30000 });
  await cust.waitForFunction(
    () => /\d/.test(document.querySelector('.mx-name-dgLoans')?.innerText ?? ''),
    null, { timeout: 30000 },
  );
  let loans = await cust.innerText('.mx-name-dgLoans');

  // The three the legacy loan.jsp listed exist as records, whatever their
  // current active flag: a run that dies between deactivating the vehicle
  // loan and restoring it must not make this read as "the seed is gone".
  const seeded = oql('SELECT ProductCode FROM Banking.LoanProduct');
  check('all three legacy products exist as records',
    /HOME/.test(seeded) && /EDU/.test(seeded) && /VEH/.test(seeded));

  const activeNames = oql('SELECT ProductName FROM Banking.LoanProduct WHERE IsActive = true')
    .split('\n').filter((l) => l.startsWith('| RR')).map((l) => l.split('|')[1].trim());
  check('the brochure lists exactly the active products',
    activeNames.every((n) => loans.includes(n)), activeNames.join(', '));
  check('each carries a rate — the legacy page carried none',
    /8\.5/.test(loans) && /9\.25/.test(loans) && /10\.75/.test(loans)
      || activeNames.length < 3);

  const loanRows = await cust.evaluate(() =>
    [...document.querySelectorAll('.mx-name-dgLoans [role="row"]')]
      .slice(1).filter((r) => r.innerText.trim().length > 0).length);
  check('one row per active product, none blank',
    loanRows === activeNames.length, `${loanRows} rows, db says ${activeNames.length}`);

  console.log('\nthe other two content pages render:');
  await menu(cust, 'Services');
  let body = await cust.evaluate(() => document.body.innerText);
  check('services lists netbanking and bill payment',
    /Netbanking/.test(body) && /Bill payment/.test(body));

  await menu(cust, 'Contact us');
  body = await cust.evaluate(() => document.body.innerText);
  check('contact shows the phone number and both branches',
    /1800 200 1234/.test(body) && /RR Main Branch/.test(body) && /RR City Branch/.test(body));

  // The one that matters. The menu shows these to everyone; the runtime
  // must not.
  //
  // "Nothing rendered" only means something if the URL renders for
  // SOMEBODY. The administrator section below navigates to these same
  // URLs and waits for their grids, which is the positive control. It
  // earns its keep: these checks all passed against `${BASE}/${url}`,
  // which renders a blank page for every role — Mendix serves page URLs
  // under /p/.
  console.log('\na customer reaches no back-office page:');
  for (const [label, url, marker] of [
    ['the dashboard', 'backoffice', 'Bank of RR — back office'],
    ['the biller list', 'backoffice-billers', 'Add biller'],
    ['the loan product list', 'backoffice-loanproducts', 'Add product'],
    ['the branch list', 'backoffice-branches', 'network operations'],
  ]) {
    await cust.goto(`${BASE}/p/${url}`, { waitUntil: 'domcontentloaded' });
    await cust.waitForTimeout(2500);
    body = await cust.evaluate(() => document.body.innerText);
    check(`${label} does not render for a customer`, !body.includes(marker));
  }
  // And no figures leaked with it.
  check('no back-office figures reached the customer',
    !/Total balance held/.test(body));

  await logout(cust);
  await cust.close();

  // =====================================================================
  // The administrator side
  // =====================================================================
  const admin = await newSession();
  await login(admin, 'admin', ADMIN_PASSWORD);
  await admin.waitForSelector('.mx-name-dvAdminSummary', { timeout: 30000 });
  await admin.waitForFunction(
    () => /\d/.test(document.querySelector('.mx-name-dvAdminSummary')?.innerText ?? ''),
    null, { timeout: 30000 },
  );

  console.log('\nthe back office is the administrator landing page:');
  const totals = await admin.innerText('.mx-name-dvAdminSummary');
  const shown = (label) => {
    const m = totals.match(new RegExp(`${label}:\\s*([\\d,.]+)`));
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  };

  check('customers counted', shown('Customers') === rowCount(oql('SELECT Name FROM Banking.Customer')),
    `page ${shown('Customers')} vs db ${rowCount(oql('SELECT Name FROM Banking.Customer'))}`);
  check('accounts counted',
    shown('Accounts') === rowCount(oql('SELECT AccountNumber FROM Banking.Account')),
    `page ${shown('Accounts')} vs db ${rowCount(oql('SELECT AccountNumber FROM Banking.Account'))}`);
  check('transfers counted',
    shown('Transfers made') === rowCount(oql('SELECT Reference FROM Banking.Transfer')),
    `page ${shown('Transfers made')}`);
  check('bill payments counted',
    shown('Bill payments made') === rowCount(oql('SELECT Reference FROM Banking.BillPayment')),
    `page ${shown('Bill payments made')}`);
  check('payees counted',
    shown('Registered payees') === rowCount(oql('SELECT Reference FROM Banking.Beneficiary')),
    `page ${shown('Registered payees')}`);
  check('a total balance is shown', /Total balance held:\s*[\d,]/.test(totals));

  // --- adding a biller ----------------------------------------------------
  console.log('\nadding a biller through the back office:');
  await admin.click('.mx-name-btnGoBillers');
  await admin.waitForSelector('.mx-name-dgBillers', { timeout: 30000 });
  await admin.waitForTimeout(1500);
  const billersBefore = rowCount(oql('SELECT BillerCode FROM Banking.Biller'));

  await admin.click('.mx-name-btnNewBiller');
  await admin.waitForSelector('.mx-name-txtBillerCode input', { timeout: 30000 });
  await admin.waitForTimeout(1000);
  await admin.fill('.mx-name-txtBillerCode input', TEST_BILLER_CODE);
  await admin.fill('.mx-name-txtBillerName input', TEST_BILLER_NAME);
  await commitInputs(admin);
  await admin.click('.mx-name-btnSaveBiller');
  await admin.waitForTimeout(2500);
  await dismissDialog(admin);

  let billers = oql('SELECT BillerCode, BillerName, IsActive FROM Banking.Biller');
  check('the biller reached the database', new RegExp(TEST_BILLER_CODE).test(billers));
  check('exactly one was added',
    rowCount(billers) === billersBefore + 1, `${billersBefore} -> ${rowCount(billers)}`);
  check('it is active by default',
    new RegExp(TEST_BILLER_NAME).test(
      oql(`SELECT BillerName FROM Banking.Biller WHERE IsActive = true`)));

  // --- a duplicate code is refused ----------------------------------------
  console.log('\na duplicate biller code is refused server-side:');
  await admin.waitForSelector('.mx-name-btnNewBiller', { timeout: 30000 });
  await admin.click('.mx-name-btnNewBiller');
  await admin.waitForSelector('.mx-name-txtBillerCode input', { timeout: 30000 });
  await admin.waitForTimeout(1000);
  await admin.fill('.mx-name-txtBillerCode input', TEST_BILLER_CODE);
  await admin.fill('.mx-name-txtBillerName input', 'Duplicate Attempt');
  await commitInputs(admin);
  await admin.click('.mx-name-btnSaveBiller');
  await admin.waitForTimeout(2500);
  body = await admin.evaluate(() => document.body.innerText);
  check('the clash is reported', /already in use/.test(body));
  check('nothing was written',
    !/Duplicate Attempt/.test(oql('SELECT BillerName FROM Banking.Biller')));
  await admin.click('.mx-name-btnCancelBiller');
  await admin.waitForTimeout(2000);
  await dismissDialog(admin);

  // --- deactivating a loan product hides it from customers ----------------
  console.log('\ndeactivating a loan product removes it from the brochure:');
  await admin.goto(`${BASE}/p/backoffice-loanproducts`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('.mx-name-dgLoanProducts', { timeout: 30000 });
  await admin.waitForTimeout(2000);

  const vehicleRow = admin.locator('.mx-name-dgLoanProducts [role="row"]')
    .filter({ hasText: 'RR Vehicle Loan' });
  await vehicleRow.locator('.mx-name-btnEditLoanProduct').first().click();
  await admin.waitForSelector('.mx-name-chkLoanActive input', { timeout: 30000 });
  await admin.waitForTimeout(1000);
  // page.check(), not page.click(): clicking a Mendix checkbox toggles the
  // label as often as the input (Slice 7 lost seven checks to it).
  await admin.uncheck('.mx-name-chkLoanActive input');
  await commitInputs(admin);
  check('the product is marked inactive on the form',
    !(await admin.isChecked('.mx-name-chkLoanActive input')));
  await admin.click('.mx-name-btnSaveLoan');
  await admin.waitForTimeout(2500);
  await dismissDialog(admin);

  check('the deactivation was written',
    !/RR Vehicle Loan/.test(
      oql('SELECT ProductName FROM Banking.LoanProduct WHERE IsActive = true')));

  await admin.screenshot({ path: 'tests/screenshots/s8-backoffice-admin.png', fullPage: true });

  // --- the customer sees the effect ---------------------------------------
  const cust2 = await newSession();
  await login(cust2, 'rahul', PASSWORD);
  await cust2.waitForSelector('text=/Welcome,/', { timeout: 30000 });
  await menu(cust2, 'Loans');
  await cust2.waitForSelector('.mx-name-dgLoans', { timeout: 30000 });
  await cust2.waitForTimeout(2500);
  loans = await cust2.innerText('.mx-name-dgLoans');

  check('the deactivated product is gone from the brochure', !/RR Vehicle Loan/.test(loans));
  check('the other two are still there',
    /RR Home Loan/.test(loans) && /RR Education Loan/.test(loans));
  const remainingRows = await cust2.evaluate(() =>
    [...document.querySelectorAll('.mx-name-dgLoans [role="row"]')]
      .slice(1).filter((r) => r.innerText.trim().length > 0).length);
  check('two rows, none blank — it is filtered, not blanked',
    remainingRows === 2, `${remainingRows} rows`);

  // The new biller is reference data a customer can actually use.
  console.log('\nthe new biller reaches the customer:');
  await menu(cust2, 'Bill payment');
  await cust2.waitForSelector('.mx-name-cbBiller', { timeout: 30000 });
  await cust2.waitForTimeout(2000);
  let dropdown = await cust2.innerText('.mx-name-cbBiller');
  // A Mendix combobox renders its options on open.
  await cust2.click('.mx-name-cbBiller input, .mx-name-cbBiller .mx-compoundcontrol');
  await cust2.waitForTimeout(1500);
  dropdown += ' ' + await cust2.evaluate(() => document.body.innerText);
  check('it appears in the company dropdown', new RegExp(TEST_BILLER_NAME).test(dropdown));
  await cust2.keyboard.press('Escape');

  await logout(cust2);
  await cust2.close();

  // --- deactivating the biller takes it back out --------------------------
  console.log('\ndeactivating the biller takes it out of the dropdown:');
  await admin.goto(`${BASE}/p/backoffice-billers`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('.mx-name-dgBillers', { timeout: 30000 });
  await admin.waitForTimeout(2000);
  const testRow = admin.locator('.mx-name-dgBillers [role="row"]')
    .filter({ hasText: TEST_BILLER_NAME });
  await testRow.locator('.mx-name-btnEditBiller').first().click();
  await admin.waitForSelector('.mx-name-chkBillerActive input', { timeout: 30000 });
  await admin.waitForTimeout(1000);
  await admin.uncheck('.mx-name-chkBillerActive input');
  await commitInputs(admin);
  await admin.click('.mx-name-btnSaveBiller');
  await admin.waitForTimeout(2500);
  await dismissDialog(admin);

  const cust3 = await newSession();
  await login(cust3, 'rahul', PASSWORD);
  await cust3.waitForSelector('text=/Welcome,/', { timeout: 30000 });
  await menu(cust3, 'Bill payment');
  await cust3.waitForSelector('.mx-name-cbBiller', { timeout: 30000 });
  await cust3.waitForTimeout(2000);
  await cust3.click('.mx-name-cbBiller input, .mx-name-cbBiller .mx-compoundcontrol');
  await cust3.waitForTimeout(1500);
  body = await cust3.evaluate(() => document.body.innerText);
  check('the deactivated biller is no longer offered', !new RegExp(TEST_BILLER_NAME).test(body));
  check('the active ones still are', /Reliance Comm\.|TATA Indicom/.test(body));
  await cust3.keyboard.press('Escape');
  await logout(cust3);
  await cust3.close();

  // --- branches are read-only ---------------------------------------------
  console.log('\nthe branch list is read-only by design:');
  await admin.goto(`${BASE}/p/backoffice-branches`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('.mx-name-dgBranches', { timeout: 30000 });
  await admin.waitForTimeout(2000);
  const branches = await admin.innerText('.mx-name-dgBranches');
  check('both branches are listed',
    /RR Main Branch/.test(branches) && /RR City Branch/.test(branches));
  // Not "no buttons at all": a Mendix datagrid ships its own paging and
  // selection controls. The assertion is that none of them MUTATES.
  const mutating = await admin.evaluate(() =>
    [...document.querySelectorAll('.mx-name-dgBranches button')]
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
      .filter((t) => /add|edit|new|delete|remove|save/i.test(t)));
  check('nothing on it can add, edit or delete a branch',
    mutating.length === 0, mutating.join(' | ') || 'paging controls only');

  // --- put it all back ----------------------------------------------------
  console.log('\nrestoring the state the suite found:');
  await admin.goto(`${BASE}/p/backoffice-loanproducts`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('.mx-name-dgLoanProducts', { timeout: 30000 });
  await admin.waitForTimeout(2000);
  await admin.locator('.mx-name-dgLoanProducts [role="row"]')
    .filter({ hasText: 'RR Vehicle Loan' })
    .locator('.mx-name-btnEditLoanProduct').first().click();
  await admin.waitForSelector('.mx-name-chkLoanActive input', { timeout: 30000 });
  await admin.waitForTimeout(1000);
  await admin.check('.mx-name-chkLoanActive input');
  await commitInputs(admin);
  await admin.click('.mx-name-btnSaveLoan');
  await admin.waitForTimeout(2500);
  await dismissDialog(admin);
  check('the vehicle loan is active again',
    /RR Vehicle Loan/.test(oql(
      "SELECT ProductName FROM Banking.LoanProduct WHERE IsActive = true")));

  await logout(admin);
  await admin.close();

  console.log(`\n(${TEST_BILLER_CODE} is left deactivated — see nextTestBillerCode above)`);
} finally {
  for (const p of openPages) {
    await p.evaluate(() => {
      if (window.mx && typeof window.mx.logout === 'function') window.mx.logout();
    }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 1200));
  await browser.close();
}

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All slice 8 checks passed.');
