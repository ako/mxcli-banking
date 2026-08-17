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
  original; no application workflow existed.

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
