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
before starting a hub run, or the second one collides.
