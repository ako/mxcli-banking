# Findings

Durable notes for future sessions: anything surprising, broken, or worked around.
Append as work proceeds; note how each finding was verified.

**Environment:** Claude Code on the web (Ubuntu 24.04, linux/amd64)
**mxcli:** `nightly-20260815-0dda3a76` (2026-08-15)
**Mendix:** 11.13.0

---

## 2026-08-17 — Bootstrap

### `mv` into the repo root collides with `.ai-context/` from `--sync-skills`

`bootstrap-app.md` provisioning step 1 says to create the app in a subfolder and
move it up:

```bash
shopt -s dotglob && mv <AppName>/* . && rmdir <AppName>
```

This fails when the seed prompt has already been followed, because seed step 2
(`./mxcli init --sync-skills`) writes `.ai-context/skills/` at the repo root, and
`mxcli new` writes its own `.ai-context/` inside the app folder:

```
mv: cannot overwrite './.ai-context': Directory not empty
```

`mv` leaves everything else moved and only `.ai-context` behind, so the failure
is partial, not atomic — worth knowing before re-running anything.

The two directories are not identical. The app's copy is a superset: it has an
`examples/` directory and a `skills/widgets/` directory that the root
`--sync-skills` copy lacks. So the fix is to keep the app's copy, not the root's:

```bash
rm -rf .ai-context && mv <AppName>/.ai-context . && rmdir <AppName>
```

Verified with `diff -rq` between the two `skills/` directories before deleting
(only difference was the extra `widgets` directory) and by `ls -a .ai-context/`
after the move.

The skill's step 1 could avoid this entirely by using `cp -a` + `rm -rf`, or by
telling the agent that the root `.ai-context` from the seed prompt is expected
and should be replaced.

### SessionStart hook survived the move unchanged

Step 1 warns to check the `.mpr` named in `.claude/bootstrap-mxcli.sh` after
moving. It was already correct — `MPR='RRNetBanking.mpr'`, no path prefix — so
no edit was needed. Confirmed by reading the script after the move.

### MxBuild was pre-cached in the environment image

`run --local --setup --ensure-db` reported `MxBuild 11.13.0 already cached at
/root/.mxcli/mxbuild/11.13.0/modeler/mxbuild` rather than downloading it. The
mxcli docs describe environment pre-install as "the robust path"; this
environment evidently does it, so the multi-hundred-MB download the skill warns
about did not happen. Postgres start, role and database creation all succeeded
on the first run (`rrnetbanking` at 127.0.0.1:5432, exit 0).

Both 11.13.0 tarballs were verified `200` on the CDN before provisioning, per
the skill's version check:

```
mxbuild 11.13.0: 200
mendix  11.13.0: 200
```

### Boot verified, and `--hub` preview works from this environment

`./mxcli run --local -p RRNetBanking.mpr` booted cold in ~10s (web client
bundled in 9.3s) and `http://localhost:8080/` answered **HTTP 200**.

`MXCLI_HUB_KEY` is set on this environment, so the optional step 8 preview
works: `./mxcli run --hub https://hub.mxcli.org -p RRNetBanking.mpr` exposed the
app at

```
https://rrnetbanking-claude-mendix-app-setup-requirements-2map3k.mxcli.org
```

The hostname is derived from the app name plus the current git branch, so it
changes when the branch changes — don't treat a preview URL as stable across
branches.

Note that `--hub` and `--local` both bind 8080; the local run has to be stopped
before starting a hub run, or the second one collides. mxcli refuses to adopt
the stale process and says so clearly rather than silently attaching to it:

```
Error: port 8080 (app) is already in use.
  Held by pid 14405: .../java -Dmendix.live-preview=enabled ...
  That is not a process mxcli started, so it is not a leftover run
```

---

## 2026-08-17 — Slice 1 (foundation, identity, home)

### `mxcli check` passing does not mean `mx check` passes

This is the single most important thing to carry forward. Every script in this
slice passed `mxcli check` cleanly, and Mendix's own `mx check` then reported
**seven errors** the MDL checker knows nothing about:

| Code | What it caught |
|---|---|
| CE0069 | `Banking.Customer.FullName` duplicated the inherited `Administration.Account.FullName` |
| CE7247 | a user entity may not carry Required/Unique validation rules — the `NOT NULL` on that same attribute |
| CE0106 | microflows used as page datasources need an allowed role |
| CE0156 | every user role needs at least one System module role |
| CE0066 | entity access out of date |

Run `~/.mxcli/mxbuild/<version>/modeler/mx check <App>.mpr` after every slice.
`mxcli check` validates MDL syntax and a set of its own rules; it does not
validate the Mendix model.

### `Administration.Account` already defines `FullName` and `Email`

Anything extending it must not redeclare them. Check with
`DESCRIBE ENTITY Administration.Account;` before adding attributes to a
user entity. Inherited members are still bindable on pages and writable in
microflows, so there is nothing to add.

### A user entity may not have any `NOT NULL` or `UNIQUE` attribute

CE7247 rejects Required/Unique validation rules on an entity used by a demo
user, or on any of its generalizations. Requiredness on customer data has to be
enforced in microflows instead. This is why `Banking.Customer` has no
constraints while `Banking.Branch` and `Banking.Account` do.

### DROP ATTRIBUTE orphans the validation rule, and MDL cannot clean it up

The worst finding of the slice. `ALTER ENTITY … DROP ATTRIBUTE FullName`
removed the attribute but left behind the validation rule that its `NOT NULL`
had created, now pointing at an attribute that no longer exists:

```
[error] [CE1613] "The selected attribute 'Banking.Customer.FullName' no longer
        exists." at Validation rule of entity 'Banking.Customer'
```

There is no way out of this with mxcli alone:

- MDL has no `DROP VALIDATION RULE` — `ALTER ENTITY … DROP VALIDATION RULE`,
  `DROP VALIDATION RULES` and `DROP RULE` are all parse errors.
- `DESCRIBE ENTITY` does not emit validation rules at all, so the orphan is
  invisible to a describe → edit → exec round-trip.
- `mxcli fix` only covers `widgets` (CE0463) and `design-properties` (CE6087).

The fix was to rebuild the entity, and because Mendix references documents by
**GUID**, everything pointing at it had to be dropped and recreated too —
recreating an entity under the same qualified name does *not* rebind existing
references. That is `mdl/s1-00-teardown.mdl`: clear the settings reference,
drop the page, the four microflows, the demo users, the association, then the
entity. Drop the association **before** the entity, or it keeps the old GUID
and mxbuild fails with `KeyNotFoundException`.

Practical consequence: keep each slice fully scripted and re-runnable. The
rebuild was cheap only because re-running `s1-01` … `s1-06` reproduced the
whole module.

### Dropping a user role leaves its demo users dangling

`DROP USER ROLE User` succeeded and left the blank app's `demo_user` behind
still referencing it — `CE1613 "The selected user role 'User' no longer
exists."` Drop the demo users first. Same class of bug as the validation rule:
mxcli drops the thing you named without following its inbound references.

### The blank app's stock `User` role is not inert

It has no module roles in a new module, but it still inherits the **default**
home page from navigation, and then fails with one `CE2729` per widget on that
page ("No access to entity … for user role 'User'"). Twelve errors from one
leftover role. Either give every role a home page, or drop the roles the app
does not use. This app dropped `User` and kept `Customer` + `Administrator`.

### `System.User` and `System.Administrator` are real but unlisted

`SHOW MODULE ROLES` lists 13 roles and none of them are System's, yet
`ALTER USER ROLE Customer ADD MODULE ROLES (System.User)` works and is
**required** by CE0156. Use `DESCRIBE USER ROLE <name>` to see them — the stock
roles reference them plainly.

### `Status` is a reserved word in MDL

It parses fine inside `CREATE ENTITY`, but a `GRANT` naming it needs the quoted
form `WRITE ("Status")`. `mxcli syntax keywords` lists the rest.

### `HEAD()` cannot appear in an IF condition

`IF HEAD($List) = empty THEN` fails the build with CE0117; `HEAD` is a list
activity, not a Mendix expression function. Assign `COUNT($List)` to a variable
and test that instead. Caught by `mxcli check` (MDL044), not by `mx check`.

### `AutoCreatedDate` is renamed to the system member `CreatedDate`

Declaring `OpenedOn: AutoCreatedDate` silently becomes `CreatedDate`, and system
members cannot be bound in a widget. For a date a page has to display, use a
plain `DateTime` and set it in a microflow. Caught by `mxcli check` (MDL022).

### Two adjacent DYNAMICTEXT widgets concatenate

Both render as `<span>`, so their text runs together with no separator —
including `RenderMode: Paragraph`. Use a block-level `RenderMode` (H1–H6) or
wrap each in its own container. Caught by `mxcli check` (MDL-WIDGET15).

### MDL cannot set module or page documentation

`ALTER PAGE … SET DOCUMENTATION` and `ALTER MODULE … SET DOCUMENTATION` are both
parse errors, and a `/** */` docblock before `CREATE PAGE` is not picked up
(entities and microflows do take one). So the two `QUAL002` lint findings for
the module and the page are not fixable with mxcli — they need Studio Pro.

### Lint QUAL004 does not see page datasources

`DS_CurrentCustomer` and `DS_MyAccounts` are both page datasources, and lint
reports both as "not called from anywhere". A false positive; the call graph
does not traverse datasource bindings.

### Browser verification: two datasources on one page race

`tests/verify-s1-dashboard.mjs` first failed intermittently for one customer and
passed for the other. The dashboard has two independent datasources —
`DS_CurrentCustomer` behind the DataView and `DS_MyAccounts` behind the
ListView — and waiting only for the welcome heading returns while the account
list is still empty. Waiting for actual row content fixes it:

```js
await page.waitForFunction(() =>
  /A\/C no:\s*\d/.test(document.querySelector('.mx-name-lvAccounts')?.innerText ?? ''));
```

Worth remembering for every later slice: waiting on the first datasource to
paint is not the same as waiting on the page.

Note also that `playwright` is installed **globally** here and ESM `import`
ignores `NODE_PATH`, so the test resolves it via `createRequire(npm root -g)`.
There is no `playwright-cli` and no `/usr/local/bin/mx-headless-shell` in this
environment — those come from the devcontainer that `mxcli init` builds, so
`mxcli playwright verify` is not usable from a plain web session.

### Row-level security confirmed end to end

The check that matters most for this app passes in a real browser: logged in as
`rahul`, account `100000002` (priya's) does not appear anywhere in the DOM, and
vice versa — even though `DS_MyAccounts` retrieves `Banking.Account` with no
owner filter at all. The XPath constraint on the entity access rule is doing the
work, which is exactly the defect the legacy JSP system could not fix.

Distinct AutoNumbers were confirmed too (`100000001`, `100000002`), so the
legacy `update acc set cac=cac+1` race is gone.

### ~~Cosmetic: the ListView renders an empty band above the first row~~

**Not cosmetic — this was the bug.** Written off here as a theme artefact and
left uninvestigated. Slice 2 identified it: the empty band was the *other*
customer's account row, retrieved by an unconstrained microflow and blanked by
the entity access rule. See the Slice 2 finding on "Apply entity access".

The lesson is the finding: an unexplained empty row in a data widget is a
security smell, not a styling one.

---

## 2026-08-17 — Slice 2 (ledger and statements)

### ⚠ Microflow retrieves do NOT apply entity access, and MDL cannot turn it on

**The most important finding so far, and it corrects a Slice 1 claim.**

A Mendix microflow retrieve ignores entity access rules unless the
microflow's *"Apply entity access"* property is set. MDL has no syntax for that
property — `APPLY ENTITY ACCESS`, `APPLYENTITYACCESS` and `WITH ENTITY ACCESS`
are all parse errors, and it appears in neither `mxcli syntax microflow.create`
nor `microflow.retrieve`.

So a datasource microflow that retrieves without an explicit ownership clause
returns **every** customer's rows. The access rule still applies at *render*
time, blanking attributes the user may not read — so the page looks correct
while the datasource has actually loaded other people's objects.

Measured on the mini statement, logged in as `rahul`, who owns three ledger
lines:

```
Currently showing 1 to 5 of 5     <- LIMIT 5 applied across ALL 6 rows in the table
ROWS: [ header,
        "",                        <- priya's, blanked by the access rule
        "8/14/2026 Debit 2000 25000 Transfer to beneficiary",
        "",                        <- priya's
        "8/3/2026 Debit 3000 27000 Bill payment - Reliance Comm.",
        "" ]                       <- priya's
```

Note the second-order damage: `LIMIT 5` was applied *before* the access filter,
so rahul lost one of his own three lines to make room for rows he cannot read.
Bounded queries are silently wrong, not just leaky.

**This means the Slice 1 conclusion "row-level security confirmed end to end"
was too strong.** The *rendered* isolation was real, and no attribute value
leaked, but `DS_MyAccounts` was retrieving both customers' accounts and relying
on rendering to hide one. The test passed because it only asserted that the
other account number was absent from the DOM — and a blanked row contains no
number either.

Fixed by stating the ownership constraint in every datasource retrieve:

```mdl
RETRIEVE $Lines FROM Banking.Transaction
  WHERE '[Banking.Transaction_Account/Banking.Account/Banking.Account_Customer = ''[%CurrentUser%]'']'
  SORT BY BookedOn DESC
  LIMIT 5;
```

The access rules stay — they are the backstop, and they are what makes a
tampered reference return nothing. The query constraint is the second lock.

**Test rule that comes out of this:** assert row *counts*, and count rendered-
with-content against total. "The other customer's ID is not in the DOM" cannot
distinguish "not retrieved" from "retrieved and blanked". Both test files now
do this.

### A datasource microflow does not re-run when an input writes to its parameter

Editing an attribute through an input widget marks the object changed but does
not refresh it, so a grid whose datasource microflow takes that object keeps
its original result. Verified: setting "To" to `1/1/2020` left all three lines
on screen.

The fix is an explicit *refresh in client* — `CHANGE $Filter (...) REFRESH;` —
triggered by a "Show statement" button. Row count then moved 3 → 1 as expected.

### ComboBox exposes no change-event property in MDL

`OnChange` works on `DATEPICKER`, but on `COMBOBOX` every spelling is
MDL-WIDGET01 *"has no property"* — `OnChange`, `onChangeEvent`,
`onChangeDatabaseEvent`, `OnChangeAction` — even though the generated widget
doc at `.ai-context/skills/widgets/combobox.md` lists `onChangeEvent` and
`onChangeDatabaseEvent` as real properties. Wiring only the date pickers would
have left the account picker silently doing nothing, so the page uses one
explicit button for all three inputs instead.

### ComboBox captions must be String attributes

`CE7247 "Only attributes of type String are allowed here."` — an AutoNumber
cannot be a `CaptionAttribute`. An expression caption would avoid a denormalised
attribute, but MDL exposes only `optionsSourceAssociationCaptionExpression`, not
the database-options-source equivalent the widget actually needs. Hence
`Banking.Account.AccountLabel`, filled by a microflow after commit (AutoNumber
has no value until then).

### `mxcli syntax` documents NON_PERSISTENT with an underscore; the parser wants a hyphen

`CREATE NON_PERSISTENT ENTITY` is a parse error. `CREATE NON-PERSISTENT ENTITY`
works. `mxcli syntax domain-model.entity.create` shows the underscore form;
`.ai-context/skills/mdl-entities.md` shows the hyphen.

### `DECLARE` must carry a value

`DECLARE $From DateTime;` followed by `$From = ...` becomes a create-variable
activity with an empty Value and fails with `CE0038 "The 'Value' property is
required."` Write `DECLARE $From DateTime = $Filter/FromDate;`.

### The trial license caps concurrent sessions, and browser tests leak them

After a few test runs, logins started failing with a bare "Sign in failed" on
the login form. Nothing in the app was wrong — the runtime log had it:

```
ERROR - Connector: An error has occurred while handling the request. :
  Maximum number of sessions exceeded! (You are currently using a trial license)
```

Closing a Playwright page does **not** end the Mendix session; it lingers
server-side until it times out. Each test run therefore burns session slots
until the cap is hit, and the symptom (failed login) points nowhere near the
cause.

Both test files now navigate to `/logout` before closing each page. If logins
start failing for no reason, check the runtime log for this message before
suspecting passwords, and restart the app to clear the accumulated sessions.

**Slice 3 update:** `/logout` helps but is not enough. The beneficiary suite
opens six sessions across three users, and running it immediately followed by
the Slice 1 and 2 suites hit the cap again. Sessions are released lazily, so the
practical rule is **restart the app between test suites**, not merely sign out
within them. Budget for this when adding suites — it is a licence limit, not
something to engineer around.

### `CREATE MICROFLOW` is not re-runnable; `exec` applies scripts that fail `check`

Two operational gotchas that cost a cycle each:

- `CREATE MICROFLOW` errors with "already exists" rather than overwriting, so a
  re-run silently skips the edit you just made. All microflow scripts here now
  use `CREATE OR REPLACE MICROFLOW`.
- `mxcli exec` does **not** refuse a script that `mxcli check` flags as an
  error. A page with an invalid widget property was written to the model
  anyway. Always run `check` before `exec` and read its output.

---

## 2026-08-17 — Slice 3 (beneficiaries)

### mxcli resolves NO forward references — not microflows, not pages, not either to the other

The single biggest structural constraint on how a slice's scripts are laid
out. A `CALL MICROFLOW` to something created later in the same file fails:

```
statement 5: microflow 'Banking.ACT_SaveBeneficiary' has validation errors:
  - CALL MICROFLOW 'Banking.ACT_UpdateBeneficiary': microflow not found
  hint: ... is defined later in this script — move its create statement before this one
```

The same applies to a page whose button opens a page defined further down
(`failed to resolve page: page not found`), and to a microflow that shows a
page. mxcli's hint is good, but the failure mode is not: with
`--continue-on-error` everything *around* the failing statement succeeds, so the
model ends up partially updated and looks fine until `mx check` runs.

Because this slice has a cycle at the design level — the overview opens the
form, the form's save returns to the overview — it has to be applied in five
files in dependency order:

| file | contents |
|---|---|
| `s3-03` | microflows that touch no page |
| `s3-04` | `Beneficiary_NewEdit` (its Save button needs s3-03) |
| `s3-05` | `ACT_NewBeneficiary` / `ACT_EditBeneficiary` (they show the s3-04 page) |
| `s3-06` | `Beneficiary_Overview` (its buttons need s3-05) |
| `s3-07` | navigation (needs s3-06) |

Within a file, define callees first.

### Row-level security makes associated objects unreadable, not just unlisted

`Banking.Account` is readable only when it is the current user's, which is
correct — and it means a customer cannot read the *payee's* account row at all.
The `Beneficiary_TargetAccount` association resolves fine, but a grid column
bound to `Beneficiary_TargetAccount/AccountLabel` renders **empty**, because the
far side is not readable.

So anything the customer must see about another customer's object has to be
copied onto a row they do own. `Banking.Beneficiary.TargetAccountNumber` is that
copy — which is also exactly what the legacy `bene.tacc` was, and is arguably
the more honest record: the number as registered, frozen at that moment.

The general rule: with row-level security, denormalise across the security
boundary or the UI silently shows blanks.

### `Show Message` is BLOCKING and MDL cannot change that

`SHOW MESSAGE 'x';` renders a modal with an OK button that stops the page until
dismissed. MDL accepts `TYPE Information|Warning|Error` but no Blocking control
— `NON-BLOCKING`, `NONBLOCKING`, `BLOCKING false` and `NOT BLOCKING` are all
parse errors.

Measured consequence: a browser test clicked Remove, and the row count stayed at
1 for 8 seconds with `dialogs: 1` on screen. The delete had actually succeeded —
the OQL showed the row gone — but the modal was covering the page and the next
click hit it instead of the grid.

Success messages were removed for this reason; only failures interrupt. The
refreshed list is the confirmation for a success.

### A microflow-datasource grid does not refresh after a delete

Same root cause as the Slice 2 statement grid: Mendix has no dependency
information for a microflow datasource, so nothing tells it to re-run. For a
delete there is not even an object left to refresh. The tests re-navigate to the
page rather than trusting in-place refresh, and that is what a user does too.

Worth revisiting if the list ever feels stale in real use.

### `id` is an XPath pseudo-attribute, not a member

`FIND($List, id = $Object)` fails the build with
`CE1613 "The selected attribute 'Banking.Account.id' no longer exists."`
It works fine inside an XPath *constraint* (`[id = $Target]`), so push the
comparison into the retrieve instead of filtering a retrieved list.

### `RETRIEVE ... LIMIT 1` returns an object, not a list

`HEAD()` over it is `CE0097 "The selected 'X' variable must be of type List."`
Either drop the `LIMIT 1` and keep `HEAD`, or keep `LIMIT 1` and use the
variable directly. Both spellings appear in this project — with `LIMIT 1` where
one row is wanted, `HEAD` where the retrieve is unbounded.

### A page parameter of a non-persistable entity cannot appear in a URL

Two errors from one cause: `CE5601` (a parameterised page needs a URL parameter
segment) and `CE5605` (a non-persistable parameter cannot be used in a URL). The
fix is to give the page no `Url` at all — it is only ever reached from a
microflow. Worth knowing before designing a form page around a non-persistent
object.

### The shipped CONV010 lint rule flagged exactly what it permits

`.claude/lint-rules/conv010_act_microflow_content.star` documents that ACT_
microflows may contain show-page, close-page, show-message and sub-microflow
calls — but its `ALLOWED_ACTIONS` list held only the older Form-era names
(`ShowFormAction`, `CloseFormAction`) and expected sub-microflow calls to arrive
as the activity type `SubMicroflow`. The catalog reports the current names:
`ShowPageAction`, `ClosePageAction`, `MicroflowCallAction`.

Result: 11 false positives out of 13 findings, which buried the 2 real ones
(a retrieve in `ACT_SaveBeneficiary`, an object change in
`ACT_RefreshStatement`). The rule now lists both spellings, and both real
findings are fixed. Lint is back to the 2 known deferred warnings.

Worth checking the other bundled rules against the catalog's vocabulary before
trusting a clean run.

---

## 2026-08-17 — Slice 4 (transfers)

### A microflow is one database transaction — that is the whole atomicity fix

Nothing had to be built for this. A Mendix microflow runs inside a single
transaction, and an error anywhere in it rolls back everything it did. So
putting the debit, the credit, the transfer record and both ledger lines in one
microflow gives all-or-nothing behaviour for free.

That is the entire difference from `PDAOU.transfer()`, which ran four
independent statements wrapped in `catch(Exception e){System.out.println(e);}`.
The Java was not missing a transaction API — it was missing the *intent*.

The corollary is that "Continue" error handling would silently defeat it by
swallowing the error and letting the flow proceed with a half-done transfer.
Lint CONV014 flags it; nothing in this project uses it.

Verified by invariant rather than by inspection: total across all accounts was
75,000 before and after, and each rejected transfer left both the balances and
the ledger row-count untouched.

### ⚠ KNOWN LIMITATION: the balance check is read-then-write

`SUB_ExecuteTransfer` reads the balance, `VAL_TransferAmount` checks it, then
the microflow writes the new one. Two transfers from the same account arriving
at the same moment can both pass the check and overdraw the account. The
transaction guarantees each transfer is *atomic*; it does not make the pair
*serialisable*.

**Correction (same day).** This finding originally said Mendix "offers no
row-level lock inside a microflow, so closing this needs" hand-built optimistic
concurrency. That was wrong in a way worth being precise about: **Mendix ships
optimistic locking as an app setting** — App Settings → **Runtime** tab →
*Optimistic locking*. With it on, the runtime tracks an `MxObjectVersion` Long
on every persistable entity, and a commit whose version no longer matches the
database throws `ConcurrentModificationRuntimeException`.

That is exactly the lost-update case here. With it enabled, the second of two
racing transfers fails its commit instead of silently overdrawing the account,
and the whole microflow rolls back with it.

Two things it does NOT do, so it is not a complete answer on its own:

- **It detects, it does not retry.** Mendix's own guidance is that the handler
  must catch the exception, *reload* the object, re-apply and retry — "trying to
  commit the same object without reloading always results in an optimistic
  locking error." Without that, the customer sees a failure rather than a
  transfer that just works. The money is safe either way, which is the important
  half.
- **It cannot be enabled from MDL.** `ALTER SETTINGS MODEL OptimisticLocking`
  fails with `unknown model setting`; the only model settings mxcli accepts are
  `AfterStartupMicroflow`, `HashAlgorithm`, `BcryptCost`, `JavaVersion`,
  `RoundingMode`, `AllowUserMultipleSessions` and
  `ScheduledEventTimeZoneCode`. So it joins strict mode (SEC005) on the
  short list of things this project needs Studio Pro for.

The remaining alternative, if the retry loop proves awkward, is to push the
debit into a conditional update (`set balance = balance - :amt where id = :id
and balance >= :amt`) via a Java action and treat "0 rows affected" as
insufficient funds — that makes check and write a single atomic statement rather
than detecting the conflict after the fact.

### `mxcli check` does not validate settings keys — only `exec` does

`ALTER SETTINGS MODEL OptimisticLocking = true;`, `UseOptimisticLocking` and
`EnableOptimisticLocking` all pass `mxcli check` cleanly. The grammar accepts
any identifier there; the key is only validated at `exec`, which then says
`unknown model setting: OptimisticLocking`.

A reminder that "check passed" means the text parses, not that the statement
means anything.

### `SHOW MESSAGE`: `TYPE` goes before `OBJECTS`, and the error says otherwise

```mdl
SHOW MESSAGE 'Reference {1}.' TYPE Information OBJECTS [$x];   -- ok
SHOW MESSAGE 'Reference {1}.' OBJECTS [$x] TYPE Information;   -- parse error
```

The wrong order is reported as `mismatched input 'TYPE'` followed by *"'Type' is
a reserved keyword in MDL. Use a different name like Type_"* — which sends you
looking for an identifier clash that does not exist. It is a clause-ordering
problem, not a naming one.

### Message parameters must be strings

`OBJECTS [$Transfer/Reference]` where `Reference` is an AutoNumber fails the
build with `CE0117 "Error(s) in expression."` — no indication of which
expression or why. Wrap it: `OBJECTS [toString($Transfer/Reference)]`.

### Denormalising across the security boundary, again

Third instance of the same pattern, now with a shape worth naming:

| Attribute | Why it exists |
|---|---|
| `Account.AccountLabel` | ComboBox captions must be String; AccountNumber is AutoNumber |
| `Beneficiary.TargetAccountNumber` | the payee's Account row is unreadable to the payer |
| `Beneficiary.PayeeLabel` | ComboBox caption again, on the transfer page |
| `Transfer.TargetAccountNumber` / `PayeeLabel` | history must survive the payee being removed |

Two forces produce these: Mendix requires String captions in selectors, and
row-level security makes other customers' rows unreadable through an
association. Both push the same way — copy what the user must see onto a row
they own. Worth budgeting for one such attribute per selector and per
cross-customer display from the start.

The last row is a different reason and a better one: `Transfer_Beneficiary`
deliberately nullifies on delete, so removing a payee neither blocks nor
destroys the transfer history. The denormalised copy is what keeps that history
readable.

### Database datasources DO apply entity access — microflow datasources do not

Worth stating alongside the Slice 2 finding, because they pull in opposite
directions. The transfer page's payee ComboBox reads
`DataSource: DATABASE Banking.Beneficiary` with no constraint of its own, and
that is safe: entity access rules apply to client database retrieves, so the
dropdown only ever lists the customer's own payees. The same lack of a
constraint in a *microflow* datasource is the leak Slice 2 fixed.

Rule of thumb: a database datasource is constrained by the model; a microflow
datasource is constrained only by what you write in it.

---

## 2026-08-17 — Slice 5 (bill payments)

### Not every selector needs a denormalised label

Worth recording as the counter-example to the four label attributes added in
Slices 2–4. The biller ComboBox binds `CaptionAttribute: BillerName`, which is
already a `String(100)` on the entity, and it just works.

So the rule is narrower than it first looked: a label attribute is needed when
the caption source is **not a String** (AutoNumber account numbers) or when the
captioned row is **not readable** by this user (another customer's account). A
plain String attribute on a readable reference-data entity needs nothing.

### `DATABASE` datasource + entity access is the safe combination

The biller dropdown reads `DataSource: DATABASE Banking.Biller` with no
constraint written anywhere, and that is fine — entity access applies to client
database retrieves. The same absence of a constraint in a *microflow* datasource
is the leak Slice 2 had to fix. Restating because the two look identical in the
MDL and behave oppositely.

### Two test-side lessons, not app bugs

Both failures in the first run of the Slice 5 suite were mine, and both are the
sort of thing that would otherwise get "fixed" by weakening an assertion:

- **Reading a ComboBox's options too early.** `innerText` on
  `.widget-combobox-menu` right after the click returns before the list is
  populated, so the check failed while `selectBiller()` — which waits for the
  `li` — succeeded moments later on the same dropdown. Wait for
  `.widget-combobox-menu li`, then read the items.
- **Reusing a form across two rejection cases.** The second rejection was
  asserted against a page still showing the first one's validation message. Each
  case now re-opens the page for a clean form. The assertion also prints which
  message it actually found, so a future failure says what happened instead of
  just "false".

### Open security items, deliberately deferred

Two lint warnings are accepted for now and must be closed before any real
deployment:

- **SEC003** — demo users are enabled at Production security level. Needed to
  demo the slice; turn off with `ALTER PROJECT SECURITY DEMO USERS OFF`.
- **SEC005** — strict mode is disabled, which weakens XPath constraint
  enforcement (CVE-2023-23835). **Not settable via MDL** — it needs Studio Pro.

Security level is Production rather than Prototype on purpose: prototype
security does not enforce entity access rules, so the row-level XPath
constraints that this app depends on would be inert.
