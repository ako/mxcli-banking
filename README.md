# RRNetBanking

An internet banking portal for "Bank of RR", built in Mendix with
[mxcli](https://www.mxcli.org/).

This is a re-implementation of a legacy Java/JSP internet banking system
(`Internet_Banking_Java_Project_report.docx`), whose original stack was JSP +
servlets + JDBC against MySQL. The Word document is the requirements source of
truth; the Java source in it is reference material, not something to port
line-by-line.

## What the app is for

Bank customers log in with a bank-issued login ID and password to do their
banking without going to the branch. From the original brief:

> The proposed system is used to maintain a account record of all the customers
> of a Bank (RR) by storing entries for customer (i.e. account details),
> investments and showing their account summary. It also allows the customer to
> view their account without going to the bank and transaction can be done
> online.

A customer can view their account summary and statements, transfer money to
registered beneficiaries, pay bills, open an additional account online from an
existing one, and maintain their own profile (name, mobile, password).

## What it keeps track of

- **Customer** — name, address, mobile, login credentials. Owns one or more
  accounts.
- **Account** — account number, balance, branch code. Belongs to a customer.
- **Transaction** — date, time, type (withdrawal / deposit) and amount, against
  an account. Statements and the mini-statement are views over these.
- **Beneficiary** — a target account registered against a customer's account,
  with a per-transfer limit. Transfers are only allowed to registered
  beneficiaries, and only up to the limit and the available balance.
- **Biller** and **BillPayment** — the companies a customer can pay bills to
  (the original listed Reliance Comm. and TATA Indicom) and the payments made.
- **LoanProduct** — Home, Education and Vehicle loans. Brochure content in the
  original; no application workflow existed. Records here rather than markup, so
  a rate change is a back-office edit rather than a redeploy.

## Who logs in

- **Customer** — sees only their own accounts, statements and beneficiaries.
  Transfers and bill payments are constrained by the beneficiary limit and the
  available balance.
- **Administrator** — maintains reference data (branches, billers, loan
  products) and supports customers. The JSP original had no admin role at all;
  Mendix needs someone able to seed and correct this data.

## Build setup

| | |
|---|---|
| Mendix version | 11.13.0 |
| Theme | `ledger` (light, dense, data-heavy — suits statements and transaction lists) |
| Tooling | mxcli, Dev Container, Claude Code |

## Implementation slices

The build is sliced vertically — each slice ends at something demoable in a
browser, not at a layer.

| # | Slice | State |
|---|---|---|
| 1 | Foundation, identity, home — Customer/Branch/Account, roles, row-level security, dashboard, demo data | **Done** |
| 2 | Ledger and statements — Transaction, account statement with date range, mini statement | **Done** |
| 3 | Beneficiaries — CRUD with validation | **Done** |
| 4 | Transfers — atomic, server-side limit and balance checks | **Done** |
| 5 | Bill payments — Biller reference data | **Done** |
| 6 | Profile and credentials, plus the dashboard summary | **Done** |
| 7 | Open an additional account | **Done** |
| 8 | Public content, loans brochure, admin back-office | **Done** |

Parked by decision, present in the source document but never implemented in it:
investments, downloadable forms, loan applications, forgot-password.

**One deliberate omission, in Slice 8.** The legacy app had an
unauthenticated front page (`1st.jsp`, `contact.jsp`, `services.jsp`) anyone
could browse. Reproducing that here means enabling guest access, which changes
the app's attack surface and is what lint SEC004/SEC007 flag. That is the bank's
call, not a detail to slip in, so Contact and Services sit behind the login with
everything else.

**One deliberate departure, in Slice 7.** The legacy "open a new account" page
created a whole new *login* and copied the customer's name, address and mobile
onto it, because its schema tied one login to one account. Slice 1 replaced that
with Customer 1..* Account, so opening an account here adds one under the
existing login. Reproducing the original would duplicate personal details once
per account. The entry point, the branch choice and the zero opening balance are
kept; the second set of credentials is not.

### Needs Studio Pro

Two settings this project cannot reach through MDL, both of which should be on
before any real deployment:

| Setting | Where | Why |
|---|---|---|
| **Optimistic locking** | App Settings → Runtime | Money movement reads a balance, checks it, then writes it. Without this, two simultaneous transfers or bill payments from one account can both pass the check and overdraw it. With it, the second commit fails instead. Note it *detects* rather than retries — a retry loop around the conflict is still worth adding. |
| **Strict mode** (SEC005) | Project Security | Strengthens XPath constraint enforcement; relevant to CVE-2023-23835. |
| **Per-role menus** | Navigation | MDL writes one menu for all roles, so a customer sees the four back-office items. Every page and microflow behind them is granted to `Administrator` only and the runtime refuses — `verify-s8-backoffice.mjs` asserts the refusal — but the menu should be split per role. |
| **The `AccountSummary` view's association** | Domain model | `Banking.AccountSummary` is a valid OQL view that mxcli can create but cannot reference — no `GRANT`, no microflow return type. Adding the association (select `c.ID`) and an access rule in Studio Pro turns the dashboard from N+1 microflow queries into one grouped query. |

Demo users are also still enabled at Production security level (SEC003) and must
be turned off. See `FINDINGS.md` for detail on all of these.

### Model scripts

Every model change is an MDL script under `mdl/`, applied with
`./mxcli exec`. They are the source of truth and are re-runnable **in filename
order** — Slice 1 was rebuilt from them once already, and
`mdl/s1-00-teardown.mdl` explains why that mattered.

Order is not cosmetic. mxcli resolves no forward references: a microflow that
calls one defined later in the same file, or a page whose button opens a page
defined below it, fails to build. Slice 3 is split across five files for
exactly this reason — see the header comment in `mdl/s3-04-pages.mdl`.

### Demo logins

Demo users are enabled (development only — see `FINDINGS.md`).

| User | Password | Role |
|---|---|---|
| `rahul` | `RRCustomer2026!` | Customer |
| `priya` | `RRCustomer2026!` | Customer |
| `meera` | `RRCustomer2026!` | Customer |
| `admin` | `RRAdmin2026!!` | Administrator |

### Verifying

```bash
~/.mxcli/mxbuild/11.13.0/modeler/mx check RRNetBanking.mpr   # model consistency
./mxcli lint -p RRNetBanking.mpr -m Banking                  # conventions
node tests/verify-s1-dashboard.mjs                           # browser, app must be running
node tests/verify-s2-statements.mjs
node tests/verify-s3-beneficiaries.mjs
node tests/verify-s4-transfers.mjs
node tests/verify-s5-billpayments.mjs
node tests/verify-s6-profile.mjs
node tests/verify-s7-openaccount.mjs
node tests/verify-s8-backoffice.mjs
```

`mxcli check` passing does **not** mean `mx check` passes. Run both.

Two rules the browser tests encode, both learned the hard way (`FINDINGS.md`):

- **Assert row counts, not just absent values.** A microflow retrieve does not
  apply entity access unless the microflow says so — and MDL cannot say so — so
  an unconstrained datasource loads other customers' rows and entity access
  merely blanks them. A blank row contains no account number, so "their number
  is not in the DOM" passes while the leak is real. Every datasource microflow
  therefore states its own ownership constraint.
- **Sign out at the end of a test — including when it fails.** The trial
  licence caps concurrent sessions, and closing a browser page does not end the
  server-side session. `verify-s8-backoffice.mjs` logs every page it opened out
  from its `finally` block; three crashed runs without that is enough to make
  the next run fail at the login form for reasons unrelated to the code.
- **Assert against the database, not against literals.** Slices 6 and 7 change
  rahul's name and give him more accounts, so `'Demo Customer rahul'` and
  `rows === 1` were true only until those suites had run once. A stale selector
  is worse than a stale literal: `.mx-name-lvAccounts` survived the Slice 6
  dashboard rebuild and the Slice 1 suite then timed out rather than failing a
  named check, so it looked broken rather than wrong. Both are fixed; the counts
  now come from `mxcli oql`.
- **Give every negative check a positive control.** Mendix serves page URLs
  under `/p/`, and the wrong form renders a blank page rather than a 404 — so
  "a customer cannot reach the back office" passed against a URL that renders
  for nobody. The same URLs are driven as an administrator in the same suite.

## Working on this repo

The `mxcli` binary is git-ignored (~85 MB). `.claude/bootstrap-mxcli.sh` fetches
it back and boots the app; the SessionStart hook in `.claude/settings.json` runs
that script automatically, so a fresh clone self-bootstraps.

```bash
./mxcli run --local -p RRNetBanking.mpr --watch --screenshot   # warm dev loop
./mxcli exec change.mdl -p RRNetBanking.mpr                     # edit the model
```

See `AGENTS.md` for the full command reference and `.ai-context/skills/` for the
MDL pattern guides. `FINDINGS.md` records anything surprising encountered along
the way.
