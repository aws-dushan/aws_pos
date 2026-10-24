# One POS — servers, releases, backups, moving

Two environments run side by side on the SFA servers, built from the same release (the same design as AWS One, `AWS One/deploy`):

| | Live | Test |
|---|---|---|
| Address | https://ralsnahashho.dyndns.org:1000/onepos | https://ralsnahashho.dyndns.org:1000/onepos-test |
| App server (AWS-App) | `onepos-live-api`, `onepos-live-web`, `onepos-live-backup` | `onepos-test-api`, `onepos-test-web`, `onepos-test-backup` |
| Database (AWS-Data) | `onepos-live-db`, PostgreSQL 17, 172.30.0.20:5444 | `onepos-test-db`, 172.30.0.20:5445 |
| Sign-in cookie | `onepos-live`, path /onepos | `onepos-test`, path /onepos-test (separate sessions) |
| Limits | API 1.5 GB, web 768 MB, database 4 GB | API 1 GB, web 512 MB, database 1 GB |

The shared SFA gateway (`aws-edge-nginx-1`, port 1000) routes the two prefixes through one file, `/opt/aws/edge/apps/onepos.conf`
(source: `app/edge-onepos.conf`). It is not in SFA's route manifest, so SFA's `sync-infra.sh` leaves it alone. Nothing of SFA or AWS One
is shared beyond that: own containers, databases and roles, folders, ports, and resource limits so neither is ever starved.

## Where everything is

Everything One POS keeps on a server is under **`/opt/aws/onepos`** (owned by the admin user, no root needed):

```
AWS-App  /opt/aws/onepos/
  compose.app.yml            app/compose.yml
  edge-onepos.conf           the gateway route (installed by `onepos route`)
  env.example                env/env.example (template for a new environment)
  bin/onepos                 control script (bin/onepos)
  live/.env  test/.env       ALL settings + passwords of the environment (mode 600) — the same file is on AWS-Data
  live/files test/files      sign-in keys (keys/), item and logo pictures (images/), till Device Service installers (releases/)
  backups/live backups/test  nightly database dumps + files archives (14 / 7 days)
  keys/offsite_ed25519       key that copies backups to AWS-Data (can only write into /opt/aws/onepos/offsite there)
  releases/<version>/        image archives (+ Device Service installer) of the last 3 releases, for rollback
  deploy.log

AWS-Data /opt/aws/onepos/
  compose.data.yml           data/compose.yml
  bin/onepos-db              database control script
  live/.env  test/.env       same files as on AWS-App
  live/pgdata                the live database files
  live/pgbackrest            point-in-time backup repository (2 weekly full + nightly differentials + every WAL)
  offsite/live offsite/test  copies of AWS-App's nightly backups
```

## Releasing a change

On the development PC (Git Bash), from the repository:

```bash
deploy/release.sh 2026.10.20-1                                   # build + copy + load on both servers
ssh aws-app /opt/aws/onepos/bin/onepos deploy test 2026.10.20-1  # test first
# … test it at /onepos-test …
ssh aws-app /opt/aws/onepos/bin/onepos deploy live 2026.10.20-1  # the same release on live
```

- One release = `onepos-api:<v>` (identical for test and live) + `onepos-web-live:<v>` / `onepos-web-test:<v>` (same source, each built
  with its address prefix) + `onepos-postgres:17-<hash>` (database and backup image, changes only when `deploy/data` changes) + the till
  Device Service installer, built for the servers' address so a double-click installs it.
- `deploy live` first takes a backup, then switches, then waits until the API (which applies database migrations at start) and the web
  app report healthy. If they don't, it goes back to the previous version automatically and says so.
- `onepos rollback live` = back to the version before. If the failed release had already changed the database, restore the backup taken
  just before it (`onepos restore live <dump>`; the deploy log names it).
- A new database image (release.sh says so): `ssh aws-data /opt/aws/onepos/bin/onepos-db up test <image>`, check, then the same for live.
- `ssh aws-app /opt/aws/onepos/bin/onepos status` and `ssh aws-data /opt/aws/onepos/bin/onepos-db status` show versions, health and the
  last backups.

### Till Device Service

The installer is built by `tools/release-device-service.ps1` with the servers' address (`-WebOrigin https://ralsnahashho.dyndns.org:1000`,
the same for live and test). A new Device Service version (raise `<Version>` in `src/OnePos.DeviceService/OnePos.DeviceService.csproj`):

```bash
deploy/release.sh <v>
ssh aws-app /opt/aws/onepos/bin/onepos publish-device test /opt/aws/onepos/releases/<v>/device-service
ssh aws-app /opt/aws/onepos/bin/onepos publish-device live /opt/aws/onepos/releases/<v>/device-service
```

Tills download it from **Devices** (first install) and update themselves within 6 hours, or at once with **Update now**. Each till's
Device Service takes updates only from the server its One POS page came from, and checks the file's SHA-256 first.
`SKIP_DEVICE=1 deploy/release.sh <v>` leaves the installer out when the Device Service didn't change.

## Backups

| What | Where | When | Keeps | Restores with |
|---|---|---|---|---|
| pgBackRest (point in time) | AWS-Data `live/pgbackrest` | full Sunday, differential other nights, 01:45; WAL continuously | ~2 weeks, to the second | `onepos-db pitr live "2026-10-20 14:05:00"` |
| Database dump (portable) | AWS-App `backups/live/db` + copy on AWS-Data `offsite/live` | 02:45 nightly and before every live deploy | 14 days (test 7) | `onepos restore live <dump>` |
| Files (keys, pictures, installers) | AWS-App `backups/live/files` + copy on AWS-Data | with the dump | 14 days | `onepos restore live <dump> <files.tgz>` |

AWS One's backups run 15 minutes earlier (01:30 / 02:30) so the two never compete. Losing either server loses nothing. **Still open: a
copy outside the building** (as for AWS One).

The sign-in keys in `files/keys` matter: they also encrypt the stored FACTS connection strings. Without them every company's FACTS
connection must be entered again. They are in every files backup.

**Refresh test from live:** `onepos refresh-test` takes a live backup and restores it into test (database + files). It is also the regular
proof that restoring works. Careful: test then holds live's FACTS settings — switch FACTS posting off on test after a refresh, or test
bills would post to FACTS.

## Moving to another server

Nothing is tied to these machines; a new server needs Docker (with compose) only. The procedure is AWS One's (`AWS One/deploy/README.md`,
"Moving to another server") with `onepos` for `awsone`: copy the `.env` files, `ONEPOS_APP_HOST=… ONEPOS_DATA_HOST=… deploy/release.sh
<current version>`, `onepos-db up`, `onepos deploy`, `onepos restore <latest dump> <latest files.tgz>`, `onepos route`.

## More memory, CPU or disk

Limits are in the .env (`API_MEMORY`, `DB_MEMORY`, `PG_SHARED_BUFFERS`, …). Change both copies of the file, then
`onepos deploy <env> <current version>` (app) / `onepos-db up <env>` (database).

## First install — `deploy/first-install.sh <version>`

Run once from the development PC after `deploy/release.sh <version>`. It writes both `.env` files with random passwords, makes the backup
key and authorises it on AWS-Data (rrsync, write-only into `/opt/aws/onepos/offsite`), starts the databases, deploys test and live,
publishes the Device Service and installs the gateway route. First sign-in on each: user `admin` with `SEED_ADMIN_PASSWORD` from that
environment's `.env`; change it at once.
