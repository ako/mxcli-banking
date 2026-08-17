/**
 * Slice 1 browser verification.
 *
 * Checks the two things the slice claims:
 *   1. A customer can log in and see their own account number, branch and
 *      balance on the dashboard.
 *   2. A customer sees ONLY their own account. This is the check that the
 *      legacy JSP system would have failed — it had no server-side
 *      authorization at all, so any logged-in user could reach any account
 *      by tampering with a request parameter.
 *
 * Run with the app already up:
 *   node tests/verify-s1-dashboard.mjs
 */
// Playwright is installed globally in this environment, and ESM `import`
// ignores NODE_PATH, so resolve it through a CJS require rooted at the
// global module directory.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const failures = [];

const oql = (q) => execSync(`./mxcli oql -p RRNetBanking.mpr "${q}"`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * How many accounts a customer actually holds.
 *
 * Hard-coded 1 here until Slice 7, which let rahul open a second one — so
 * the row-count assertion below asks the database rather than assuming.
 */
/**
 * The FullName the database holds for a login.
 *
 * Not a literal: the Slice 6 suite exercises profile editing and renames
 * rahul, so 'Demo Customer rahul' is only true until that suite has run
 * once. What this slice claims is that the welcome shows the INHERITED
 * FullName, which is checked by comparing against the stored value.
 */
const fullNameOf = (login) => {
  const row = oql('SELECT Name, FullName FROM Banking.Customer')
    .split('\n').find((l) => new RegExp(`\\|\\s*${login}\\s*\\|`).test(l));
  return row ? row.split('|').map((c) => c.trim()).filter(Boolean)
    .find((c) => c !== login) : null;
};

const accountsHeldBy = (login) => (oql(
  'SELECT a.AccountNumber, c.Name FROM Banking.Account as a '
  + 'inner join Banking.Account_Customer/Banking.Customer as c',
).match(new RegExp(`\\|\\s*${login}\\s*\\|`, 'g')) ?? []).length;

function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

async function login(page, user, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"], #usernameInput', { timeout: 30000 });
  await page.fill('input[name="username"], #usernameInput', user);
  await page.fill('input[name="password"], #passwordInput', password);
  await page.click('button[type="submit"], .login-button');
  // The dashboard heading renders when DS_CurrentCustomer returns, but the
  // account list is a second, independent datasource — waiting only for the
  // heading races it and intermittently sees an empty list.
  //
  // The grid is .mx-name-dgAccounts, not the .mx-name-lvAccounts listview
  // this suite was written against: Slice 6 replaced the Slice 1 dashboard
  // with the per-account summary. This suite kept passing on nothing until
  // the Slice 8 regression run, because a stale selector times out rather
  // than failing a named check.
  await page.waitForSelector('text=/Welcome,/', { timeout: 30000 });
  await page.waitForSelector('.mx-name-dgAccounts', { timeout: 30000 });
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('.mx-name-dgAccounts')?.innerText ?? ''),
    null,
    { timeout: 30000 },
  );
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

const browser = await chromium.launch({ headless: true });

try {
  // --- rahul ------------------------------------------------------------
  console.log('\nrahul (Customer):');
  let page = await browser.newPage();
  await login(page, 'rahul', 'RRCustomer2026!');

  let body = await page.innerText('body');

  // Count the account rows, not just look for absent numbers. An
  // unconstrained retrieve returns other customers' objects and entity
  // access blanks them, so they render as EMPTY rows — invisible to a
  // "is 100000002 in the DOM" check but very much loaded. See FINDINGS.md.
  const accountRows = async () => page.evaluate(() => {
    const grid = document.querySelector('.mx-name-dgAccounts');
    if (!grid) return { total: -1, withContent: -1 };
    const items = [...grid.querySelectorAll('[role="row"]')].slice(1);
    return {
      total: items.length,
      withContent: items.filter((i) => i.innerText.trim().length > 0).length,
    };
  });

  check('welcome shows the inherited FullName',
    body.includes(fullNameOf('rahul')), fullNameOf('rahul'));
  check('anti-phishing notice is present', /never sends you email\/SMS/.test(body));
  check('own account number is shown', /100000001/.test(body));
  check('branch name is shown', /RR Main Branch/.test(body));
  check('balance is shown', /\d{2},?\d{3}/.test(body));
  // Slice 1 showed the branch CODE and the account STATUS here. Slice 6
  // replaced both with the two figures a customer opens a banking app for
  // — how many ledger lines the account has and when it last moved. The
  // branch code is still on the record; it is just not on this page.
  check('the ledger count and last activity are shown',
    /Transactions/.test(body) && /Last activity/.test(body));

  // The row-level security check: priya's account must not be visible.
  check(
    "priya's account is NOT visible to rahul",
    !/100000002/.test(body),
    'XPath constraint on Banking.Account',
  );

  const rowsRahul = await accountRows();
  const heldByRahul = accountsHeldBy('rahul');
  check(
    'exactly his own accounts were retrieved, none blank',
    rowsRahul.total === heldByRahul && rowsRahul.withContent === heldByRahul,
    `${rowsRahul.withContent} with content / ${rowsRahul.total} total, db says ${heldByRahul}`,
  );

  await logout(page);
  await page.close();

  // --- priya ------------------------------------------------------------
  console.log('\npriya (Customer):');
  page = await browser.newPage();
  await login(page, 'priya', 'RRCustomer2026!');
  body = await page.innerText('body');

  check('welcome shows the inherited FullName',
    body.includes(fullNameOf('priya')), fullNameOf('priya'));
  check('own account number is shown', /100000002/.test(body));
  check(
    "rahul's account is NOT visible to priya",
    !/100000001/.test(body),
    'XPath constraint on Banking.Account',
  );

  const rowsPriya = await accountRows();
  const heldByPriya = accountsHeldBy('priya');
  check(
    'exactly her own accounts were retrieved, none blank',
    rowsPriya.total === heldByPriya && rowsPriya.withContent === heldByPriya,
    `${rowsPriya.withContent} with content / ${rowsPriya.total} total, db says ${heldByPriya}`,
  );

  await page.screenshot({ path: 'tests/screenshots/s1-dashboard-priya.png', fullPage: true });
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
console.log('All slice 1 checks passed.');
