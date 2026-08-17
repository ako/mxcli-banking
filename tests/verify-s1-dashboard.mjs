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
  await page.waitForSelector('text=/Welcome,/', { timeout: 30000 });
  await page.waitForSelector('.mx-name-lvAccounts', { timeout: 30000 });
  await page.waitForFunction(
    () => /A\/C no:\s*\d/.test(document.querySelector('.mx-name-lvAccounts')?.innerText ?? ''),
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
    const lv = document.querySelector('.mx-name-lvAccounts');
    if (!lv) return { total: -1, withContent: -1 };
    const items = [...lv.querySelectorAll('li')];
    return {
      total: items.length,
      withContent: items.filter((i) => i.innerText.trim().length > 0).length,
    };
  });

  check('welcome shows the inherited FullName', /Demo Customer rahul/.test(body));
  check('anti-phishing notice is present', /never sends you email\/SMS/.test(body));
  check('own account number is shown', /100000001/.test(body));
  check('branch name and code are shown', /RR Main Branch/.test(body) && /RR001/.test(body));
  check('balance is shown', /25,?000/.test(body));
  check('account status is shown', /Active/.test(body));

  // The row-level security check: priya's account must not be visible.
  check(
    "priya's account is NOT visible to rahul",
    !/100000002/.test(body),
    'XPath constraint on Banking.Account',
  );

  const rowsRahul = await accountRows();
  check(
    'exactly one account row was retrieved, none blank',
    rowsRahul.total === 1 && rowsRahul.withContent === 1,
    `${rowsRahul.withContent} with content / ${rowsRahul.total} total`,
  );

  await logout(page);
  await page.close();

  // --- priya ------------------------------------------------------------
  console.log('\npriya (Customer):');
  page = await browser.newPage();
  await login(page, 'priya', 'RRCustomer2026!');
  body = await page.innerText('body');

  check('welcome shows the inherited FullName', /Demo Customer priya/.test(body));
  check('own account number is shown', /100000002/.test(body));
  check(
    "rahul's account is NOT visible to priya",
    !/100000001/.test(body),
    'XPath constraint on Banking.Account',
  );

  const rowsPriya = await accountRows();
  check(
    'exactly one account row was retrieved, none blank',
    rowsPriya.total === 1 && rowsPriya.withContent === 1,
    `${rowsPriya.withContent} with content / ${rowsPriya.total} total`,
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
