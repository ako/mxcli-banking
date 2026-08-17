/**
 * Slice 6 browser verification.
 *
 * Three things:
 *
 *   1. The dashboard summary — one row per account with balance, ledger
 *      count and last activity. This is the feature the AccountSummary
 *      OQL view was meant to feed; it is fed by DS_MyDashboard instead
 *      because MDL cannot read or secure a view entity (see FINDINGS.md).
 *
 *   2. Profile self-service, with the legacy mobile rules now enforced
 *      SERVER-side. mobile.jsp checked ten digits and a 7/8/9 prefix in
 *      JavaScript, and the servlet then wrote whatever arrived straight
 *      into custd.
 *
 *   3. The SMS seam. The legacy prose promised "The changed username and
 *      password can be send through the sms" and shipped no SMS code at
 *      all. Nothing is sent here either — but a row is queued, and the
 *      test asserts it exists, which is the difference between a seam and
 *      an absence.
 *
 * NOTE: this test changes rahul's password and changes it back. If it
 * fails midway, rahul's password may be RRCustomer2027! rather than the
 * usual one.
 *
 *   node tests/verify-s6-profile.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const globalRoot = process.env.NPM_GLOBAL_ROOT
  ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const require = createRequire(`${globalRoot}/`);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'RRCustomer2026!';
const TEMP_PASSWORD = 'RRCustomer2027!';
const failures = [];

function check(name, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

const oql = (q) => execSync(`./mxcli oql -p RRNetBanking.mpr "${q}"`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

async function login(page, user, password = PASSWORD) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#usernameInput, input[name="username"]', { timeout: 30000 });
  await page.fill('#usernameInput, input[name="username"]', user);
  await page.fill('#passwordInput, input[name="password"]', password);
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

async function openProfile(page) {
  await dismissDialog(page);
  await page.click('a:has-text("Profile")');
  await page.waitForSelector('.mx-name-txtMobile input', { timeout: 30000 });
  await page.waitForTimeout(1500);
}

/**
 * Mendix commits an input's value to the model on BLUR, not on keystroke.
 * Clicking the submit button straight after `fill` races that, and the
 * microflow then runs against the previous value — which is how an earlier
 * version of this test saw the *old* validation message and reported a
 * working feature as broken. Tab out first.
 */
async function commitInputs(page) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
}

async function saveProfile(page, { name, mobile }) {
  if (name !== undefined) await page.fill('.mx-name-txtFullName input', name);
  if (mobile !== undefined) await page.fill('.mx-name-txtMobile input', mobile);
  await commitInputs(page);
  await page.click('.mx-name-btnSaveProfile');
  await page.waitForTimeout(2500);
  return page.evaluate(() => document.body.innerText);
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await login(page, 'rahul');

  // --- the dashboard summary ----------------------------------------------
  console.log('\nthe dashboard shows a per-account summary:');
  await page.waitForSelector('.mx-name-dgAccounts', { timeout: 30000 });
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('.mx-name-dgAccounts')?.innerText ?? ''),
    null, { timeout: 30000 },
  );
  const dash = await page.innerText('.mx-name-dgAccounts');

  check('the account and branch are shown', /100000001/.test(dash) && /RR Main Branch/.test(dash));
  check('the balance is shown', /\d{2},?\d{3}/.test(dash));
  check('the ledger count is shown', /Transactions/.test(dash));
  check('a last-activity date is shown', /\d{1,2}\/\d{1,2}\/\d{4}/.test(dash));

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.mx-name-dgAccounts [role="row"]')]
      .slice(1).filter((r) => r.innerText.trim().length > 0).length);
  check('exactly one summary row, none blank', rows === 1, `${rows} rows`);

  // --- server-side mobile validation --------------------------------------
  console.log('\nthe legacy mobile rules are now enforced server-side:');
  await openProfile(page);

  let body = await saveProfile(page, { mobile: '12345' });
  check('a short mobile number is rejected', /must be 10 digits/.test(body));

  body = await saveProfile(page, { mobile: '1234567890' });
  check('a mobile number not starting 9/8/7 is rejected', /must start with 9, 8 or 7/.test(body));

  const stored = oql('SELECT Name, MobileNumber FROM Banking.Customer');
  check('neither invalid number was written',
    !/1234567890/.test(stored) && !/12345\b/.test(stored));

  // --- a valid profile change queues an SMS -------------------------------
  console.log('\nchanging the mobile number queues the SMS the legacy app promised:');
  const notifBefore = (oql('SELECT Reference FROM Banking.Notification')
    .match(/\|\s*\d{9}\s*\|/g) ?? []).length;

  // Pick a number that is NOT the current one. SUB_ApplyProfile only
  // queues an SMS when the mobile actually changed, which is correct
  // behaviour — an earlier version of this test hard-coded one number and
  // reported that correctness as a failure on the second run.
  const currentMobile = oql('SELECT Name, MobileNumber FROM Banking.Customer');
  const newMobile = /9876543210/.test(currentMobile) ? '9812345678' : '9876543210';

  body = await saveProfile(page, { name: 'Rahul Sharma', mobile: newMobile });
  check('the profile saved', /Profile updated/.test(body));
  await dismissDialog(page);

  const after = oql('SELECT Name, FullName, MobileNumber FROM Banking.Customer');
  check('the new name was written', /Rahul Sharma/.test(after));
  check('the new mobile number was written', new RegExp(newMobile).test(after));

  const notifs = oql('SELECT Reference, Recipient, Message, IsSent FROM Banking.Notification');
  const notifAfter = (notifs.match(/\|\s*\d{9}\s*\|/g) ?? []).length;
  check('an SMS was queued', notifAfter === notifBefore + 1, `${notifBefore} -> ${notifAfter}`);
  check('it is addressed to the NEW mobile number', new RegExp(newMobile).test(notifs));
  check('it is queued, not sent', /false/.test(notifs));

  // --- password change ----------------------------------------------------
  console.log('\nchanging the password:');
  await openProfile(page);
  await page.fill('.mx-name-txtNewPassword input', TEMP_PASSWORD);
  await page.fill('.mx-name-txtConfirmPassword input', 'something-else');
  await commitInputs(page);
  await page.click('.mx-name-btnChangePassword');
  await page.waitForTimeout(2500);
  body = await page.evaluate(() => document.body.innerText);
  check('a mismatched confirmation is rejected', /do not match/.test(body));

  await page.fill('.mx-name-txtNewPassword input', TEMP_PASSWORD);
  await page.fill('.mx-name-txtConfirmPassword input', TEMP_PASSWORD);
  await commitInputs(page);
  await page.click('.mx-name-btnChangePassword');
  await page.waitForTimeout(2500);
  body = await page.evaluate(() => document.body.innerText);
  check('the password was changed', /Password changed/.test(body));
  await dismissDialog(page);

  await page.screenshot({ path: 'tests/screenshots/s6-profile-rahul.png', fullPage: true });
  await logout(page);
  await page.close();

  // The real proof: the new password works and the old one does not.
  console.log('\nthe new password actually took effect:');
  const p2 = await browser.newPage();
  let loggedIn = true;
  try {
    await login(p2, 'rahul', PASSWORD);
  } catch { loggedIn = false; }
  check('the OLD password no longer works', !loggedIn);
  await logout(p2);
  await p2.close();

  const p3 = await browser.newPage();
  await login(p3, 'rahul', TEMP_PASSWORD);
  check('the NEW password works', true);

  // Put it back, so the suite is re-runnable and the other suites still work.
  await openProfile(p3);
  await p3.fill('.mx-name-txtNewPassword input', PASSWORD);
  await p3.fill('.mx-name-txtConfirmPassword input', PASSWORD);
  await commitInputs(p3);
  await p3.click('.mx-name-btnChangePassword');
  await p3.waitForTimeout(2500);
  body = await p3.evaluate(() => document.body.innerText);
  check('the password was restored for the other suites', /Password changed/.test(body));
  await dismissDialog(p3);
  await logout(p3);
  await p3.close();
} finally {
  await browser.close();
}

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All slice 6 checks passed.');
