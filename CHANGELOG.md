# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [Unreleased]

**A launcher can now tell gbrain that a session's user turns are an agent's, not yours, so orchestrator worker briefs stop landing in your brain as your own preferences (#8064). Codex sessions that open and close with no prompt no longer raise a week-long parser_drift alert (#8016), and task notifications and agent-team messages no longer get brain context injected as if you typed them (#8028).**

Set `GBRAIN_SESSION_AGENT=<label>` on a worker's process and the capture hooks still save the session, but every claim from its user turns is saved as `attributed_to: other` with the context note `speaker: agent <label>, not the owner`, and the extractor is told the agent wrote them. `GBRAIN_SESSION_AGENT=off` saves nothing from the session; `owner` declares the turns yours. With the variable unset, a headless `claude -p` or `codex exec` session whose ancestors include another claude or codex process is detected and saved as agent `agent-launched`'s. The marker is a `<session>.speaker.json` sidecar written before any corpus file; if it can't be written, nothing is saved. Agent claims are never consolidated into your own takes.

### Itemized changes

- `src/core/context/session-speaker.ts` (new): the env contract, ancestry detection, the speaker sidecar.
- `src/commands/hook.ts`: compact, stop and session-end record the speaker before banking and skip banking on `off`; user-prompt skips `<task-notification` and `<teammate-message` prompts (`harness_prompt`); a session-end that saves turns clears its own lane's `parser_drift` status file, which now records the lane.
- `src/core/facts/backstop.ts`, `src/core/facts/extract.ts`, `src/core/facts/speaker-context.ts`, `src/core/persistence/facts-maintenance.ts`: the `speaker` pipeline option.
- `src/core/context/checkpoint-harvest.ts`, `src/core/sweep.ts`: the capture lanes pass the corpus file's speaker.
- `src/core/transcripts/codex-hook-lane.ts`: `event_msg` / `thread_settings_applied` counts as a recognized record.
- `docs/guides/ambient-writeback.md`: "Sessions an agent launches".

## [0.60.519.0] - 2026-10-30

**The unit lane now runs 28 shards instead of 22, on shard weights refreshed from the Oct 30 nightly. With the fresh weights, every one of 22 shards would be planned at 624.4 s against the 600 s per-shard budget; at 28 shards the largest is 490.6 s.**

`UNIT_SHARDS` is 28. `test.yml`'s unit matrix and `e2e.yml`'s `coverage-full-unit` matrix follow it, and `test/scripts/unit-shard-budget.test.ts` pins both, still two shards per runner. The unit, serial and E2E weight maps and their metadata come from the Oct 30 nightly mining run, and weight coverage is clean: 4366 unit, 446 serial and 832 E2E files, with no dead entries.

### Itemized changes

- `scripts/sharding.ts`: `UNIT_SHARDS = 28`.
- `.github/workflows/test.yml`, `.github/workflows/e2e.yml`: the unit and coverage-full-unit matrices and their `--manifest-expect` lists.
- `scripts/test-weights.json`, `scripts/serial-weights.json`, `scripts/e2e-weights.json` and their `.metadata.json`: the Oct 30 refresh.
- `docs/TESTING.md`: the shard counts.

## [0.60.518.0] - 2026-10-30

**`gbrain repair secret-spans --source <id> --slug <slug>...` replaces the credentials the secret scanner finds in the database copies of the pages you name with `<REDACTED:rule>` markers and changes nothing else, held pages included (GST-327).**

A credential pasted into a page lives in more places than its file: the page row, timeline, fact and take rows, link contexts, raw connector data and the chunks built from them. A page that sync holds keeps its stale database copy, so redacting the file never reaches it. The new kind reads every one of those copies, plans the spans with the scanner's own rules (`--rules`, default every named credential rule; the two broad heuristics only when named) and proves the result equals the scanner's redaction byte for byte before it writes. The preview shows counts per rule and each changed field's old and new SHA-256, never a value; `--apply --expect <hash>` rewrites exactly that set, one transaction per page, keeps trust tiers, rebuilds the chunks from the redacted body and re-scans what it wrote. It writes no file and no commit, leaves sync holds as they are, keeps page versions as history, and works the same on a repo-less brain. Explicit-only and trusted-local-CLI-only.

### Itemized changes

- `src/core/secret-spans.ts` (new): the pure span planner and proof (`redactFields`, `resolveSecretRules`, `residualMatches`); `src/core/secret-scan.ts` exports `NAMED_SECRET_RULES`.
- `src/core/repair/secret-spans.ts` (new): the repair kind (preview, preview-bound apply, per-page receipt, re-scan), registered explicit-only and preview-bound; `gbrain repair` accepts `--rules` and `--slug` for it.
- `docs/guides/repair.md`: the `secret-spans` section and table row.
- Tests: `test/secret-spans.test.ts`, `test/repair-secret-spans.test.ts` (repo-less and managed brains, segmented embed_skip page, held page, impossible timeline date, `preview_changed`, remote refusal); the explicit-kind lists in `test/repair-explicit-only.test.ts` and `test/fix-wave-5-integration.test.ts` name the new kind.

## [0.60.517.0] - 2026-10-30

**The crash robot now runs two writer runs at a time, with the same runs, faults and manifest order as before, so its Postgres and PGLite cells finish well inside their ceilings again (#8036). reconcile-owner-journey is split by transport, so neither half hits the serial lane's 300 s per-file cap on a slow runner (#8040).**

Every crash-robot run was executing one after another, so a slow runner plus the 2-minute `pooler_disconnect` lease wait pushed the Postgres cell to 899 s against its 880 s ceiling. The driver now draws every random schedule, fault point and seed in the old order before anything runs, executes `ROBOT_CONCURRENCY` (2) runs at a time, each with its own scratch root, database and `GBRAIN_HOME`, and reports results in the original manifest order. Ceilings and seeds are unchanged. Measured locally, Postgres went from 423 s to 258 s and PGLite from 699 s to 418 s, with identical manifests and no violations; on CI, Postgres took 369 s against its 880 s ceiling and PGLite 531 s against 1200 s.

`test/reconcile-owner-journey.serial.test.ts` ran its stdio and http owner journeys in one file. On a runner pinned to one core it was killed at 301 s. Each transport is now its own file over a shared helper (`test/helpers/reconcile-owner-journey.ts`), with the same four cases and assertions; on that probe the two halves passed in 214 s and 193 s.

The pregate allowlists `pii.phone.e164` only for `scripts/*-weights.metadata.json`, whose run IDs look like phone numbers, and two comments about the 22-minute unit job timeout no longer carry a bare shard-count literal.

### Itemized changes

- `scripts/persistence/robot-driver.ts`: a `pooled` runner at `ROBOT_CONCURRENCY`, results stored by item index, and a per-run `HOME`/`GBRAIN_HOME`. `test/persistence-crash-robot.test.ts` checks that concurrent runs cover exactly the serial runs, faults and manifest order.
- `test/helpers/reconcile-owner-journey.ts`, `test/reconcile-owner-journey.serial.test.ts`, `test/reconcile-owner-journey-http.serial.test.ts`; `scripts/serial-files.tsv` gains the http file.
- `.gstack/pregate.json`: the scoped allowlist. `scripts/test-shard.sh`, `test/scripts/unit-shard-budget.test.ts`: comment wording.
- Docs: `scripts/persistence/README.md`, `docs/ci-event-parity.md`.

## [0.60.516.0] - 2026-10-30

**The crash robot no longer reports a lost write when the user's own Git commit in a sync race never landed (#8043).**

In `sync_and_connector_race_direct_write`, the robot plays a user who edits a page file, commits it and syncs while an agent edits the same page. It ran `git add` and `git commit` without reading their exit status. On one Postgres run (seed 5105, `sync:mid_checkpoint#13`) the commit did not land, but the sync ran anyway and was counted as a committed write of the user's marker. Sync correctly imports nothing from an uncommitted file, so the group check called the page lost. The same missing commit explains why the agent's edit was refused as an "uncoordinated local edit" rather than `pending_import` (what it gets whenever the commit lands, 150 of 150 local Postgres runs), and why the planned fault was never reached: there were no imports to checkpoint. CI kept no git stderr, so this is the best-supported cause, not a proven one: a sync that advanced its cursor without importing the page would leave the same signature. The fix tells the two apart, so a `lost_write` here from now on is a real sync bug.

The user step now checks that its commit landed. It retries while another Git process holds a lock, for up to 20 s. Any other failure throws with git's stderr and fails the run as a harness error, so the model never sees a sync whose commit does not exist. A failing run's trace now also shows each sync's `fromCommit`, `toCommit`, `added` and `modified`, so a recurrence is diagnosable from the manifest. The reference model is unchanged.

### Itemized changes

- `scripts/persistence/ops.ts`: `userEdit` writes and commits the user's files and verifies them clean at HEAD (retrying a held lock, throwing otherwise) before `executeOp`'s try, and `runSync` now only runs `sync_brain`; a sync observation keeps the commits and counts the sync reported. `scripts/persistence/crash-robot.ts`: the failure trace prints that for sync and connector ops.
- Tests: `test/persistence-crash-robot.test.ts`, under "a sync op whose user commit did not land". The forced probe holds `index.lock` across the user's commit: on the previous code it reproduces the CI result (sy2 `uncoordinated local edit`, sy1 committed, `lost_write`), and now the commit lands and the race leaves no violation. A refused commit fails the op instead of reporting it committed, and a committed sync whose marker the page lacks is still `lost_write`.

## [0.60.515.0] - 2026-10-30

**gbrain's Ubicloud VMs now carry a TTL in gstack's name grammar, `ubirun-<owner>-<epoch>-<suffix>-t<H>`. gstack's runner reaps any TTL-less `ubirun-*` VM of the caller's owner after 4 h; under the new names, a gbrain gate, soak or dev VM lives until its own TTL ends and no longer.**

`ci:ubicloud` names gate VMs `…-ciNN<hex>-t2` by default. `--ttl-hours` takes 1 to 999; `0` (no expiry) is gone. `ubi-runner.sh up` and `run` give every name they generate a TTL: `--ttl-hours H`, or `-t999` (about 41 days) without it. The production soak defaults to `-t15`. The operator reaper (`scripts/ubicloud/reap-expired.ts`) reads `-t<H>` names from every owner and tool as expiring H hours after creation. It keeps reaping the older `-x<expiry>` names until none are left, and still never selects a TTL-less, untagged-legacy or foreign name. Follow-ups are in #8050.

### Itemized changes

- `scripts/ubicloud/reap-expired.ts`: a `-t<H>` grammar ahead of the `-x<expiry>` one; `expiringVmName` writes `-t<H>`, 1 to 999.
- `scripts/ubicloud/ubi-runner.sh`: `new_name` always appends `-t<H>` (default 999); `--ttl-hours` accepts 1 to 999.
- `scripts/ci-ubicloud.ts`: `--ttl-hours` accepts 1 to 999; batch log names drop the TTL suffix.
- `scripts/bench/production-soak/ubicloud.sh`: default TTL 15.
- Docs: `scripts/ubicloud/README.md`, the runner header and usage text, `docs/TESTING.md`.

## [0.60.514.0] - 2026-10-30

**A correctly redacted transcript page now clears `gbrain transcripts audit-secrets`, and a missing-file page under a `db_only` directory is kept rather than deleted in two more cases: on company-brain sources (#8014), and whenever gbrain.yml's storage lines cannot be fully resolved (#8015).**

The importer writes redaction markers like `login **<REDACTED:user-pattern>**`, and the `labeled_credential` detector read the marker itself as a typed user/password pair, so a page that was already redacted failed every audit (#7997). The labeled patterns now scan a copy of the line in which a standalone marker is rewritten to an inert token of the same length, while the reported value is still cut from the original line. A password written beside a marker, or glued straight onto one, is still found. The audit detector version moves to 3, so `gbrain doctor` asks for one fresh audit.

Company-brain sources skipped the `db_only` check when retiring pages whose files are not in the approved manifest, so they deleted live database-only pages (#8014). Their deletes now go through the same verdict as other managed sources, read from gbrain.yml at the approved commit, never from the working tree.

The `db_only` resolver now fails closed (#8015). A `db_only` or `supabase_only` line whose inline value the parser refuses (a missing comma, a nested list, an unquoted value with spaces) counts as unresolved even when another key resolved, and a held page is released only when its verdict is known. A deprecated `supabase_only` list ignored beside canonical keys now holds only the pages under its directories that `db_only` does not cover, `gbrain storage status` names those directories, and the deprecation warnings no longer point to a `gbrain doctor --fix` rename that does not exist.

Contributed by @Masashi-Ono0611 (#7997 report and #7999).

### Itemized changes

- `src/core/secret-scan-labeled.ts`, `src/core/secret-scan.ts`: `neutralizeRedactionMarkers` and a per-pattern scan subject; `src/core/transcripts/secret-audit.ts`: audit version 3.
- `src/core/persistence/sync-discovery.ts`: company delete entries carry their slug and go through `retireDbOnlyDeletes` with a verdict from the approved commit's gbrain.yml.
- `src/core/storage-config.ts`: `dbOnlyVerdict`, a stricter flow-list parser, `ignored_db_only` in place of a boolean, and the stricter unresolved rule; `src/core/persistence/sync-pass.ts` and `source-storage.ts` use the per-slug verdict; `src/commands/storage.ts` warns about ignored directories.
- Docs: `docs/storage-tiering.md`, `docs/guides/repair.md`. Three `BEHAVIOR_CHANGES` rows.
- Tests: `test/secret-scan-redaction-marker-7997.test.ts` (new), `test/company-brain-runtime.test.ts`, `test/sync-storage-invalid-8007.test.ts`, `test/storage-config.test.ts`, `test/storage-pglite.test.ts`.

## [0.60.513.0] - 2026-10-30

**A search on a brain with many pages still waiting for a projection no longer spends seconds in the readiness check: the probe stops after it finds a pending page instead of also walking every unsealed page for the `by_design` answer it then discards (#8000).**

The readiness probe that runs before every uncached `search` and `query` asked two questions in one statement: is any page in scope pending, and are the only unsealed pages protected ones (`by_design`). The second answer is only used when nothing is pending, but Postgres evaluated both. While pages are pending there is usually no protected page for its `LIMIT 1` to stop at, so it read every unsealed page on every cold call. On a synthetic brain with 235k pending image pages that was most of the `meta_readiness` stage. The statement now evaluates `by_design` only when nothing is pending, still in one round trip, and returns the same `ready`, `projection_pending` and `by_design` answers.

Contributed by @Masashi-Ono0611, whose #8004 proposed the short-circuit.

### Itemized changes

- `src/core/search/projection-readiness.ts`: the probe reads `pending` in a materialized CTE and `by_design` inside `CASE WHEN pending THEN false ELSE … END`, so its subplan never runs while pages are pending.
- Tests: `test/projection-readiness.test.ts` (PGLite) and `test/e2e/projection-readiness-plan-postgres.test.ts` (Postgres) pin the plan: with pending pages only one scan of `pages` executes.

## [0.60.512.0] - 2026-10-30

**After an automatic self-upgrade, the autopilot now restarts the serve your installed service runs when it is still on the old build, so one auto-upgrade no longer leaves two builds running until someone runs `gbrain upgrade --restart-only` by hand.**

With `self_upgrade.mode auto`, the autopilot's `--swap-only` channel installs the new build and exits so its own supervisor relaunches it. The serve that launchd (`com.gbrain.serve`) or systemd (`gbrain-serve.service`) runs kept the old build, doctor's `runtime_build_skew` failed, and the audit's `restart_pending` was never acted on. The relaunched autopilot now checks that serve once per process. When it reports an older build, the autopilot restarts it through the service and verifies that it came back on the new build, under the same auto-mode, quiet-hours and idle gates as the swap. It records the step in the self-upgrade audit as `restart_serve` (`applied`, or `skipped` with `manual` or `unverified`). A serve that the service does not run, one started by hand or from another install, is never touched, and doctor's fix for it stays `gbrain upgrade --restart-only`.

The systemd pid read also stopped passing a value flag to `systemctl show` and parses the `MainPID=` line instead, which removes a flag that `gbrain upgrade`, `gbrain post-upgrade` and `gbrain autopilot` listed as accepted but never took.

### Itemized changes

- `src/commands/upgrade-restart.ts`: `planServeRestart`, `restartStaleServeService` and `restartServeAfterSelfUpgrade` (auto mode, quiet hours and idle only, once per autopilot process, audited as `restart_serve`); the systemd `MainPID` read parses `MainPID=<n>`.
- `src/commands/autopilot-daemon.ts`: runs the serve check after `attemptAutopilotSelfUpgrade` with the autopilot's idle signal; `src/commands/autopilot.ts` exports `computeAutopilotIdle` for it.
- `src/core/cli-flag-registry.generated.ts`: regenerated; the never-accepted value flag is gone from the `upgrade`, `post-upgrade` and `autopilot` rows.
- Docs: the Restart section of `docs/guides/upgrades-auto-update.md` and the `upgrade-restart.ts` key-files entry.
- Tests: `test/autopilot-serve-restart-7475.test.ts`.

## [0.60.511.0] - 2026-10-30

**Sync no longer deletes pages it cannot prove are deletions while gbrain.yml's storage section is invalid, and one-line `db_only: [dir/]` lists now take effect.**

A managed sync keeps a live page whose file is gone when the page sits under a declared `storage.db_only` directory, because the database copy is canonical. When gbrain.yml's storage section did not load (a directory in both `db_tracked` and `db_only`), or declared `db_only` in a shape the parser resolved to nothing, that check answered "not database-only". Those pages were then soft-deleted, and the retention purge removed them for good (#8007). Sync now treats the answer as unknown: it keeps each such page and holds its path as `file_drift` with reason `storage_invalid`. The same applies when a deprecated `supabase_only` list sits next to canonical keys, which makes gbrain ignore it. `gbrain repair file-drift --prefer file` and `sync.apply_held_deletions` skip these pages too. Once gbrain.yml is fixed and synced, the holds clear and each page is decided under the fixed config.

### How to use it

- If `gbrain sync` reports pages "kept, not deleted" or `gbrain sources status` shows `storage_invalid` holds, run `gbrain storage status`. It names the problem. Fix gbrain.yml, commit it, then run `gbrain sync --source <id> --no-pull`.
- Storage tiers can be written as a one-line flow list: `db_only: [media/x/, 'archive/']`.

### What changes after you upgrade

| Situation | Before | After |
|---|---|---|
| gbrain.yml tiers overlap and a file disappears | the page was deleted, then purged | the page is kept and held `storage_invalid` |
| `db_only` written as a flow list split over lines | resolved nothing: missing-file pages deleted | resolves nothing: missing-file pages held, and `gbrain storage status` warns |
| `db_only: [dir/]` on one line | ignored | declared: gitignored, published database-only, kept when its file is gone |
| `db_tracked: [...]` or `keep_db: [...]` on one line | ignored | take effect |
| `db_only: []` | made the sync baseline commit refuse | declares no directory |

### Itemized changes

- `src/core/storage-config.ts`: quote-aware one-line flow lists; an explicit `[]` is no unresolved declaration; an ignored deprecated `supabase_only` list is flagged.
- `src/core/persistence/source-storage.ts`, `sync-discovery.ts`, `sync-pass.ts`, `sync-classify.ts`, `sync-pass-apply.ts`, `sync-holds.ts`: the three-valued db_only verdict, the `storage_invalid` hold, its remediation, rescreen and release.
- `src/core/persistence/sync-held-deletions.ts`, `src/core/repair/file-drift.ts`: skip pages whose db_only verdict is not a definite no.
- `src/commands/storage.ts`, `src/commands/sync-diagnostics.ts`: the unresolved-declaration warning and the kept-pages summary line.
- Tests: `test/sync-storage-invalid-8007.test.ts` (PGLite and Postgres), `test/sync-classify-storage-invalid-8007.test.ts`, and new cases in `test/storage-config.test.ts` and `test/storage-pglite.test.ts`.

## [0.60.510.0] - 2026-10-30

**Tier 2's keyed nightly now actually gives the agent gbrain's MCP tools and fails any test in which the agent never called one, and a Tier 1 graduation shard that executed nothing now fails instead of passing.**

Tier 2 wrote its gbrain MCP server into `~/.openclaw/config.json`, which OpenClaw 2026.4.9 never reads, since it reads `mcp.servers` in `~/.openclaw/openclaw.json`. The agent ran with no gbrain tools, and each test checked only that OpenClaw exited 0 and printed something, which it also does when the model key is rejected (#8002). The job now saves the server with `openclaw mcp set` and fails unless `openclaw mcp show` reads it back. It serves gbrain's starter surface (31 tools), because OpenClaw's default agent model is `openai/gpt-5.4`, OpenAI refuses a request with more than 128 tools, and OpenClaw's own 31 tools plus gbrain's full 158 come to 189. The server runs behind `scripts/ci-mcp-tap.sh`, which logs every JSON-RPC request, and each Tier 2 test fails unless the agent made a gbrain tool call while it ran. The `tier1-graduation` shards now run `scripts/require-executed-tests.ts` after their tests, because the graduation files skip without `DATABASE_URL` and `run-e2e.sh` exits 0 on an all-skip run, so a shard with a broken database env used to pass with nothing executed (#8003).

### Itemized changes

- `.github/workflows/e2e.yml`: Tier 2's "Configure OpenClaw MCP" step runs `scripts/ci-openclaw-mcp.sh` and its test step gets `GBRAIN_TEST_TIER2_MCP_TAP_LOG`; each `tier1-graduation` shard runs the executed-tests check on lane `tier1`.
- `scripts/ci-openclaw-mcp.sh`, `scripts/ci-mcp-tap.sh` and `scripts/mcp-tap-calls.ts`: the MCP registration, the request tap and its reader.
- `test/e2e/skills.test.ts`: each test asks for a gbrain MCP tool and requires a gbrain tool call.
- Tests: `test/scripts/tier2-openclaw-mcp.test.ts` and two new cases in `test/scripts/require-executed-tests.test.ts`.

## [0.60.509.0] - 2026-10-30

**Doctor stops flagging harnesses you already wired, large file uploads no longer load the whole file into memory, `restore --detach` keeps database-only pages, and you can clear Git push failures that no retry will ever fix.**

This release fixes eight bugs that people hit in day-to-day use. Doctor said Claude Code had no gbrain connection even after setup had recorded one. It reported deleted workspaces as broken, and `doctor --only` ignored the check you named. Uploading a large original read the whole file into memory, and a file that changed partway through could leave a half-written copy behind. Restoring a page you had declared database-only, and then syncing, treated its missing file as a deletion. And a Git push that failed for good, because the file was now database-only or a later push had already written it, stayed "held" in status and doctor forever.

### How to use it

- `gbrain doctor --only harness_wiring` (or any wave check id) runs just that check.
- `gbrain sources writer settle-effects <source> --parked-code <code>` previews which failed Git pushes can be settled. `--apply --expect <plan_hash>` records the settlement, and `--unsettle` reverses it.
- Uploads (`gbrain files upload`, `upload-raw`, sync) stream from disk on their own. Nothing to turn on.

### What changes after you upgrade

| Situation | Before | After |
|---|---|---|
| Setup recorded a project-scope MCP registration | doctor warns "no gbrain MCP registration" | doctor reads it and reports ok |
| A push-status record from a deleted workspace | reported as unreadable status | skipped |
| A 5 GB original uploaded to S3 | read fully into memory | multipart upload with bounded memory |
| The file changes while it uploads | a partial or mismatched object could be stored | refused, nothing stored, the existing attachment kept |
| `restore --detach` on a page declared `db_only`, then sync | the next sync deleted it again | the page stays database-only |
| A failed push whose target is now `db_only` | held in status and doctor indefinitely | settle it once and it stops blocking |

### Things to watch

- Settling never touches the failure record, the request or the file bytes. It only marks the effect settled, and only on proof: the target falls under `db_only` in the current `gbrain.yml`, or the upstream ref you already fetched holds bytes a later push wrote. Nothing is fetched, and a stale or missing ref refuses.
- Downloads and restores of very large originals still read the whole object into memory. This release makes uploads memory-safe only.

### Itemized changes

- Doctor: `harness_wiring` reads the bootstrap receipt and its workspace `.mcp.json` (#7422). Push status skips records whose workspace is gone (#7377). `doctor --only <wave check>` runs just that check, and self-session lookups are read once per run (#7343).
- Retention: purging tombstones under an adopted skillpack declared database-only also reaches skill paths outside the bundle (#7345).
- `restore --detach` publishes a declared `db_only` page database-only, and sync keeps it (#7324).
- Storage: S3 multipart, Supabase standard and TUS, and local streamed uploads with a hash check before each backend's publish step. The local backend writes a sibling `.partial` file and renames it into place. `file_changed_during_upload` refuses a file that changed during its upload (#7427). Contributed by @Masashi-Ono0611.
- `gbrain sources writer settle-effects` (`writer_settle_effects`): preview-first, plan-bound settle and unsettle of failed Git effects. Doctor (`parked_effects`, git convergence), parked groups, push holds, writer status, sync status (`writeback_failed`, `git_push_held`), the pass idle probe, deactivation and bulk retries skip settled rows. `--parked-pushes` now reaches a failed current-binding push with no parked data (#7423, #7378).

## [0.60.508.0] - 2026-10-30

**The E2E full run is shorter and Tier 2 no longer reports green on a run where it executed nothing: Selected E2E uses up to 14 workers, Tier 1's graduation files run in 2 shards of their own, and Tier 2 runs keyed on the nightly schedule with a check that fails when any of its tests skipped.**

Selected E2E shards set the E2E critical path in most full-ci runs, and Tier 1 ran its 15 graduation files one after another for about 15 minutes. Tier 2 installed OpenClaw on every run, then skipped all 3 tests because the test preload strips the model keys, and still counted green. Now Selected E2E can run up to 14 workers (`MAX_E2E_WORKERS`), and the graduation files run in a `tier1-graduation` job split into 2 weighted shards, against direct Postgres and PgBouncer as before and on the same `tier1` receipt lane; `e2e-status` requires that job. Tier 2 runs keyed only on the nightly E2E schedule and on a `full_corpus` dispatch. On other events `e2e-status` accepts its skip with a `Tier 2 (LLM Skills) not run: keys withheld` notice, and on the nightly `scripts/require-executed-tests.ts` fails the job when any Tier 2 test skipped or none ran. `GBRAIN_PAID_LANES=0` still turns it off. A new test fails when a Selected E2E or graduation shard of the full corpus, scaled by the measured actual-to-predicted factor plus setup time and a minute of margin, would pass its job timeout.

### Itemized changes

- `.github/workflows/e2e.yml`: 14 Selected E2E workers, the `tier1-graduation` shards, keyed Tier 2 on the nightly and `full_corpus`, and the keys-withheld notice in `e2e-status`.
- `scripts/require-executed-tests.ts`: fails a lane whose tests skipped or never ran.
- `scripts/e2e-matrix.ts`, `scripts/e2e-provider-key-notice.sh`, `scripts/structural-suites.tsv` and `.gstack/pregate.json` follow the new jobs.
- Docs: `docs/ci-event-parity.md`, `docs/ci-red-runbook.md`, `docs/TESTING.md` and the key-files entry.
- Tests: `test/scripts/e2e-shard-budget.test.ts`, `test/scripts/require-executed-tests.test.ts`, and the wiring, matrix, routing and paid-lane tests.

## [0.60.507.0] - 2026-10-30

**`search`, `query` and `assemble_evidence` now return a conversation page's text as a quoted excerpt, with tool calls in it (JSON or XML-style) replaced by a one-line summary, so an agent reading the result can't mistake an old tool call for a live one.**

Imported chat transcripts can quote tool-call or function-call JSON, or XML-style call blocks, from the original conversation: a pasted agent log, a model that wrote its call as text. Search used to return that JSON verbatim, and one agent harness's prompt-injection classifier flagged such a result as malicious (#7600).

A row whose page has type `conversation` (what `gbrain transcripts ingest` and the chat connectors write) now comes back with `quoted: "transcript"` and its `chunk_text` wrapped: a line naming the page as source material, not instructions, then the text inside a code fence it cannot close. Each tool-call block of these shapes becomes `[tool call: <name>, arguments omitted]`: a JSON object whose `type` names a tool or function call (`tool_use`, `function_call`, `tool_call` and their variants), a `tool_calls`, `function_call` or Gemini `functionCall` value, or an XML-style `function_calls`, `invoke`, `tool_use` or `tool_call` element. Escaped or untyped JSON is not summarized and stays inside the fence. An XML block cut off at either end of a chunk is replaced, and so is a JSON block cut at the end or whose type key is still in the chunk; tool results, prose that names a tag, and the conversation around a block stay. This happens at read time where `search` and `query` shape their rows (MCP and the CLI both pass through it) and where `assemble_evidence` assembles its evidence. An open-ended or cut block stops at the next message's speaker line, with LF or CRLF line endings. Under `return_unit: auto` an explicit `token_budget` counts the fence, so the delivered evidence still fits it, and a conversation-heavy result can come back with fewer or shorter rows (a rank-one conversation row is still returned when the fence alone is larger than a very small budget); budgets under other units and `query`'s legacy chunk budget do not count the fence, so those rows can run over by the marker and fence lines; a row's `delivered.tokens` and `match_spans` and the delivery's `tokens_delivered` and `budget_used` describe the fenced text. Stored pages, ranking and scores are unchanged, and every other page type comes back byte-for-byte as before. Only type `conversation` is quoted, and only by these three operations: `recall`, `think`, `search_exact`, `fetch` and `get_chunks` still re... (line truncated to 2000 chars)

### What to watch for after you upgrade

- A script that reads `chunk_text` of conversation rows sees the marker line and fence around the text. Read `quoted` to tell them apart; `get_page` still returns the page as stored.
- `gbrain search` prints a conversation row as `[quoted transcript]` followed by the start of its text.
- `snippet_chars` caps the text inside the fence; the marker and fence lines come on top. With `search.evidence_date_header` on, a quoted row's `[observed …]` header (with its title under `search.evidence_titles`) stays the first line of `chunk_text`, ahead of the marker line, as on every other delivered block. Only a first line that is that header stays outside the fence, and a tool-call block after it can never take it over; anything else is fenced.

### Itemized changes

- `src/core/search/transcript-quote.ts`: the JSON and XML tool-call neutralizer, the fence and the CLI preview; `src/core/ops/search.ts` `searchOutput` and `src/core/search/evidence-delivery.ts` `assembleEvidenceForHits` apply them, and `capEvidenceToBudget` counts the fence; `SearchResult.quoted`, kept in lean rows.
- `test/search/transcript-quote.test.ts` (JSON and XML block shapes, blocks cut at either end or by an evidence omission or cut line, results and prose left alone) and `test/search-transcript-quote.test.ts` (a synthetic alice-example ChatGPT export through the importer; remote MCP `search`, `query` and `assemble_evidence` and the CLI human and `--json` output on both engines; an ordinary page with the same JSON unchanged), and `test/search-transcript-quote-budget.test.ts` (budget, spans and snippet cap through `search` and `assemble_evidence`, both engines). `test/e2e/evidence-delivery-leak.test.ts` checks the quote wrapper exactly and keeps its get_page subset and budget checks on the text inside it.
- Docs: `docs/mcp/README.md` lean rows, `docs/evidence-delivery.md` (spans, tokens and the snippet cap on quoted rows), the key-files entry.

## [0.60.506.0] - 2026-10-30

**A remote `search` or `query` that names no `limit` now returns every page that matched the query's words, a name or an exact identity, but at most 3 pages in total that matched only by meaning. On the multi-member harness with embeddings on (two harnesses, 40 trials before and after), an agent's search used to return a median 13 pages, nearly the whole test brain, with 79 pages from other members' sources. With this release it returns 3, those pages drop to 17 (3 of them from calls that asked for `limit` themselves), and tasks passed rose from 0 of 39 to 18 of 40. Keyword-only searches were unchanged. A connection with no source grant whose sources hold no page is now refused with `sources_not_readable` instead of answering empty, and `gbrain sources add` prints the command that fixes it.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A remote `search` or `query` with no `limit`, embeddings on | the vector arm filled the mode's row limit with every page it could reach | every page with a keyword, title, alias or exact-identity match, plus pages found only by meaning up to 3 pages in total. A line after the results says how many were left out and that `limit` returns them; `_meta.retrieval.page_cap` counts them |
| The same call with an explicit `limit`, a paged call (`offset`), an image `query`, a host-run subagent tool call, or any CLI call on the brain host (a thin-client CLI call is remote, so it gets the cap and prints the line on stderr; pass `--limit` for every row) | | unchanged |
| `gbrain eval longmemeval --via-operation` | the operation's full default limit | the capped agent contract, so recall past 3 pages is not comparable with earlier via-operation receipts; `search.remote_page_cap 0` measures the uncapped list |
| A brain with no embedding model (keyword search) | | unchanged: every keyword match comes back |
| Changing the cap | | `gbrain config set search.remote_page_cap <n>`; `0` turns it off |
| An unscoped remote `search`, `query`, `recall` or `list_pages` from a connection with no source grant that comes back empty, when every source it reads holds no page (for `recall` and `query`, no world fact either) and other sources do | `[]` with a `sources_not_readable` notice (kind degraded) | refused with `sources_not_readable` (class host_only). The fix runs on the brain host: `gbrain sources federate <source>`, with the source the user picks, or a grant for the token (`gbrain auth rescope --token <name> --sources <ids>`). It never names a source the connection cannot read |
| The same read when its sources hold pages that match nothing, or on a brain with no pages; any read from a token granted sources, an OAuth client, a bound connection, or one that names `source_id` or `source_ids` | | unchanged |
| `gbrain sources add` without `--federated` or `--no-federated` on a brain that is not managed, where connections with no source grant read no page | a stderr warning | also `next: gbrain sources federate <id>` on stdout |
| `gbrain sources add --json` on a brain that is not managed (a managed brain prints its lifecycle receipt, as before) | not available | `{id, name, local_path, remote_url, federated, next?}` on stdout; the human lines move to stderr |

Every vector path (the hybrid vector arm, the embedding-failure fallback and the `query` image branch) now has a test proving it reads only the sources the keyword path reads, for granted tokens and per-call `source_id`/`source_ids`, on PGLite and Postgres. No scope gap was found.

### What to watch for after you upgrade

- An agent that needs the full ranked list (a "find every" or landscape question) should pass `limit`; the line after capped results tells it so.
- The cap is a default for what one call returns, not an access boundary. Access is still per source: give each member's token only its sources.
- A deployment whose no-grant tokens used to get `[]` from an empty floor now gets an error. Federate the source those connections should read, or grant the tokens their sources.
- Nothing is rewritten on upgrade, and there is no schema migration.

## [0.60.505.0] - 2026-10-30

**Every harness install path now puts "check gbrain first" next to each turn, and an install whose per-turn hook can't load fails instead of passing quietly.**

Harness evals found agents use the brain when the rule reaches them on every turn and almost never when it rides only the MCP tool list or a startup file. `gbrain setup claude-code|codex --instructions-only` (the step after a plain `claude mcp add` or `codex mcp add`), `gbrain connect --install`, the hosted `gbrain connect --harness … --install` and `gbrain bootstrap harness` now add one UserPromptSubmit hook that prints only the brain-first rule. It reads no brain data, and it steps aside when setup, bootstrap or a gbrain plugin already wires the event, so a turn gets the rule once. Each install then proves the hook loads: it runs the hook on Claude Code and Codex, `openclaw plugins inspect gbrain-turn-rule --runtime --json` on OpenClaw and `hermes hooks doctor` on Hermes, and exits non-zero with `turn_hook_not_loaded`, naming that check, when it doesn't. With no absolute gbrain binary to put in the hook, the install prints the one-line next step instead.

On OpenClaw and Hermes, a plain MCP registration hides gbrain's tools behind `tool_search`, so the per-turn rule there now names the tools and how to reach them. `_meta.brain_hot_memory` is documented for harness authors.

### What to do after upgrading

- Nothing for a new install. For an install made before this release, `gbrain doctor` (`harness_wiring`) warns when a recorded brain-first block has no per-turn hook and names the command that adds it: `gbrain setup <claude-code|codex> --instructions-only`.
- `--no-instructions` removes the rule and its hook; `--no-hooks` on `bootstrap harness` installs none.

### Itemized changes

- New `src/core/setup/turn-hook.ts` (the `turn-rule` hook lane: Claude Code `turn-rule-v1` entry, Codex `hooks.json` group plus its trust entry) and `src/core/setup/turn-hook-check.ts` (`inspectTurnHook`, `verifyTurnHook`, the fix that names each harness's own check).
- New error code `turn_hook_not_loaded` (reasons `missing`, `untrusted`, `hook_failed`, `no_rule`, `not_loaded`); runbook in `docs/guides/repair.md#turn-hook-not-loaded`. Doctor `harness_wiring` reports `details.turn_hooks`.
- `gbrain bootstrap harness` names the rule hook in its consent block. Registrar mode (a non-loopback URL) stays MCP-only, and `--no-capture` keeps the rule hook because it captures nothing.