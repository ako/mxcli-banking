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

### Cosmetic: the ListView renders an empty band above the first row

Visible in `tests/screenshots/s1-dashboard-priya.png`. Harmless, not yet
investigated — likely a ledger-theme ListView toolbar area. Polish item.

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
