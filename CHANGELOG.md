# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [0.60.461.0] - 2026-10-25

**On a managed brain, releasing a held fact (`gbrain trust release h<id>`) now writes it into its entity page's `## Facts` table through the page-write door, so the released fact lives in Git and a re-import keeps it, instead of a database-only row the file never had.**

### What changed

| Situation | Before | Now |
|---|---|---|
| The owner releases a held fact whose entity page exists, on a managed brain | the fact was inserted as a database-only row; the page's file never held it, so the fact had no Git home | a new `trust_release` page write appends the fact as a row of the page's `## Facts` fence (the shared `prepareFenceFactAppend` door) and flips the hold in the same publication; the row is stamped `user_confirmed` with origin `trust_release`, the belief ledger records the hold as its cause, and the page keeps its trust tier |
| The hold names an existing fence row (a fence-guard hold) | the release inserted a second, database-only twin next to the file's own row | the release indexes the existing row: one row, and the file is unchanged |
| The hold is decided after the release was accepted | — | the release fails `preview_changed` and writes nothing; a retry of the same release replays the same request (its id derives from the hold) |
| The entity page is deleted or private, or the request is remote | — | the release refuses (remote: `confirmation_required`) and the fact stays held |

### What to watch for after you upgrade

- A hold with no entity slug, or whose entity page does not exist, still releases database-only as before; unmanaged brains are unchanged.
- Facts released by an earlier version are not moved into fences on upgrade; nothing is rewritten and there is no schema migration.

## [0.60.460.0] - 2026-10-25

**Facts that belong in a page's `## Facts` table now get there and stay there: a legacy fact row with an empty notability or confidence is adopted instead of halting reconciliation every run, `repair duplicate-facts` keeps the fenced copy, and consolidation on a managed brain closes a fenced fact in its fence row so a re-import no longer reopens it.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A legacy fact row has an empty `notability` or `confidence` (a long-lived database whose column lost its NOT NULL) | the row rendered as `null` in the fence, was refused as unadoptable (`parse`) on every run, held its page out of fact reconciliation and booked an `integrity_guard` halt each cycle | it is adopted with the column defaults (notability `medium`, confidence 1); the fence cell is written first and the row derives its values from it. A row with no kind or visibility is still refused |
| `gbrain repair duplicate-facts` finds a fact both in a fence row and as an older database-only copy | it kept the older database-only copy and set the fenced copy aside, so the kept row stayed unfenced | it keeps the fenced copy and supersedes the legacy copy onto the fence row (never withdrawn); with no fenced copy it still keeps the oldest row. Still preview-first and explicit |
| Dream consolidation on a managed brain closes an older fact that sits in its page's facts fence | only the database row was closed, and the next sync or re-import of the page reopened it from the open fence cell | the close is written into the fact's fence row and published with the take, and the database row takes its value from that cell. Unfenced facts close in the database as before; a fact fenced on another page is left open |
| `remember` writes a fact into an entity page's facts fence | its own fence-row construction | one shared door (`prepareFenceFactAppend`) renders, numbers and publishes the row, byte for byte as before; a new refusal code `fence_row_changed` names a fence row that no longer reads back as the fact a request indexes |

### What to watch for after you upgrade

- Pages that halted fact reconciliation on an empty notability or confidence adopt their rows on the next maintenance run, which edits those pages' `## Facts` tables.
- Facts an earlier release closed in the database only during consolidation are not changed on upgrade; nothing is rewritten and there is no schema migration.
- Unmanaged brains consolidate as before.

## [0.60.459.0] - 2026-10-25

**`gbrain sources host-repo` hosts a new, empty source in a bare repository that people clone, with every write committed there through the door. A claim now refuses a linked Git worktree whose link is broken.**

A hosted brain keeps one bare repository per source (`<dir>/repo.git`), which users clone and fetch from and which can push to a repository of their own. gbrain checks it out once as a linked worktree it owns (`<dir>/worktree`) and claims that worktree through the ordinary claim, with every physical-root and manifest check. The source becomes git-canonical (`canonical: git`), so every write, remote ones included, commits to the bare repository's branch before the database indexes it. Recovery, receipts and the push effect are unchanged.

Only the door moves the hosted branch. Git refuses a push to a branch a worktree has checked out, but that stops once the worktree is removed and pruned, so a pre-receive hook refuses every push and names the way in. Door commits are local ref updates and the push to the user's remote is outgoing, so the hook stops neither.

The verb runs only from the trusted local CLI and previews by default: the preview says in words that the source becomes strict, and the apply needs its `--expect <plan_hash>` (a moved plan refuses `preview_changed`). It starts only from an empty, unbound source and an empty directory outside every checkout. On a hosted source the preview reports the hook and the worktree link, and the apply reinstalls a missing or changed hook.

### What to watch for after you upgrade

- Nothing changes for an existing source. Run host-repo on a production brain only with the user's explicit yes, one source at a time.
- Pushes to `--push-remote` start once Git durability is enabled (`gbrain sources writer git-durability <id> --enable`).
- A source add or claim of a linked worktree whose checkout moved or whose repository entry was pruned now refuses `git_worktree_link_broken`. Fix it with `git worktree repair` from the repository, or add the worktree again.

### Itemized changes

- `src/core/persistence/hosted-repo.ts`, `src/commands/sources-host-repo.ts`: the verb, its plan and hash, the hook, and the refusals `hosted_repo_refused` (`source_bound`, `source_has_pages`, `source_has_path`, `source_archived`, `dir_not_empty`), `overlapping_path` and `strict_requires_managed`.
- `src/core/persistence/worktree-link.ts` and one line in `source-lifecycle.ts` `localRoot`: the `git_worktree_link_broken` refusal.
- `test/hosted-repo-g7b2.test.ts` (both engines, remote=true writes): one commit per write on the bare branch named by its receipt, a G3 pass that changes nothing, the landed-before-row replay, foreign pushes refused with and without the worktree, the push effect to the user remote, the refusals, broken worktree links, and a remote `extract_entities` on an unmanaged brain refused `strict_requires_managed`.
- Docs: `docs/designs/GIT_CANONICAL_MEMORY.md`, `docs/guides/multi-source-brains.md` "Hosted repositories", the key-files entries, error codes.

## [0.60.458.0] - 2026-10-25

**`gbrain sources canonical <id> --to git` converts a source to strict git-canonical mode, and `--to mixed` turns it back. It previews every page it would adopt into Git, declare database-only or let Git win, and refuses to lose any database content.**

The command is off unless an operator runs it, trusted local CLI only, on a managed brain. Nothing rewrites data on upgrade.

### What changed

| Situation | Before | Now |
|---|---|---|
| Turning a source strict | no verb; only the config flag | `gbrain sources canonical <id> --to git` previews per-category counts bound to HEAD by a plan hash; `--apply --expect <hash>` runs it |
| Pages the database holds ahead of Git, or pages with no file and no declared class | stayed database-only | adopted: their export bytes are committed through the door, 200 pages per commit, with no database row changed |
| Ignored and db_only paths, derive folders, images, private pages | n/a | declared database-only; nothing written, nothing deleted |
| Held deletions, and unknown-side drift whose row equals the committed file | open holds | resolved by Git wins |
| Any database content the conversion would lose, including unknown-side drift whose row differs from HEAD, or a working-tree edit that differs from both HEAD and the database | n/a | refused with `git_conversion_blocked`, listed by path |
| Work that lands between the last pass and the flag | n/a | a strict pass and a re-preview run after the flag; anything left ends `git_conversion_incomplete` and the source stays strict |
| Turning strict off | edit the config | `--to mixed` removes the flag and changes nothing else |
| A strict source's page that no import record proves (`legacy_unverified`) | kept the database version | imports the committed blob (conversion adopts such pages first) |

### Itemized changes

- `src/core/persistence/git-conversion.ts` (new) and `src/commands/sources-canonical.ts` (new): the plan, the apply and the CLI. Remote callers get `trusted_cli_required`; unmanaged brains get `strict_requires_managed`; there is no MCP operation.
- `src/core/persistence/sync-discovery.ts` and `src/commands/sync.ts`: an internal `SyncOpts.canonicalOverride` the apply uses for its strict-equivalent pass; it has no CLI flag and refuses remote callers.
- `src/core/persistence/sync-classify.ts`: `legacy_unverified` takes the committed blob on a strict source.
- Reclassifying a parked effect onto a declared-ignored page stamps `pages.database_only_reason` in one transaction (metadata only).
- `src/core/error-registry.ts`: `git_conversion_blocked`, `git_conversion_incomplete`. Fault points `conversion:group_committed`, `conversion:before_flip`.
- Tests: `test/git-canonical-conversion-g8a.test.ts` on PGLite and Postgres.

## [0.60.457.0] - 2026-10-25

**Remote MCP callers and thin clients that write to a git-canonical source (`canonical: git`, off by default) are now proven to commit through the owner's door, and a door commit that landed before its row stays on the write's receipt.**

When a remote OAuth client or legacy token writes to a strict source, the write becomes a journal request, and the owner's door commits it to Git before the database row commits. The new suite covers every page-content operation a remote caller has, on PGLite and Postgres. If the owner is down, the caller gets `write_pending` with its request id. A grant revoked while the request waits is refused with no commit and no row.

One gap is closed. A door commit can land and the transaction then fail; if the grant is revoked before the replay, the replay ends `permission_denied`. Until now its receipt said nothing, though Git holds the bytes and the indexer will import them. The receipt now names that commit with `landed_before_row: true`. They were authorized when they were committed, and a later revocation does not take committed content back.

### What to watch for after you upgrade

- Nothing changes for sources without `canonical: git`.
- A tool that reads a failed write's `outcome` may now see `outcome.persistence` with `landed_before_row: true`: the content is in Git and will be indexed.

### Itemized changes

- `src/core/persistence/pending-import.ts` `landedCommit`: the newest commit in the recovery record's `door.head..HEAD` that touched the path; an empty range stamps nothing.
- `src/core/persistence/coordinator.ts` `recoverPublication` stamps the landed commit on the requeued request; `src/core/persistence/journal.ts` `completeWrite` keeps it on a receipt that ends without committing. Group members name the one group commit.
- `test/git-door-remote-g7b.test.ts` (both engines): remote OAuth and legacy-token writes through the door, owner down, revoked grant, landed commit on the receipt, group commit.
- Docs: `docs/designs/GIT_CANONICAL_MEMORY.md` "Remote and hosted writes", `docs/architecture/thin-client.md`, the key-files entry.

## [0.60.456.0] - 2026-10-25

**In an OpenClaw workspace, `gbrain bootstrap render` writes the due-job list as SCHEDULES.md, and the OpenClaw skill scaffold installs five brain-first skills instead of the full bundle. `list_brain_skillpack` names each skill `name` instead of `slug`.**

OpenClaw 2026.10.6 retired its own HEARTBEAT.md, and `openclaw doctor --fix` archives and removes any workspace file by that name, so the rendered AGENTS.md pointed at a missing file. Render now detects an OpenClaw workspace (`OPENCLAW_WORKSPACE_DIR`, `OPENCLAW_WORKSPACE`, or a workspace under `OPENCLAW_STATE_DIR`, `~/.openclaw` or `~/.openclaw-<profile>`), or takes `--host openclaw`, and writes SCHEDULES.md; AGENTS.md names whichever file was written. Other harnesses and minimal mode keep HEARTBEAT.md.

OpenClaw puts every workspace skill's list entry in every prompt, so the full scaffold (127 files, 64 skills) cost each model call whether or not a skill was used. `gbrain skillpack scaffold --harness openclaw` without `--persona`, `--skill` or `--all` now installs query, brain-ops, capture, data-loss-gate and resolve-before-asking (30 files). On a 10-task harness check with claude-haiku-5-5, the bundle's prompt cost per model call over an MCP-only install fell from 4,867 tokens to 816, about 38,000 input tokens per trial, with the same pass rate (12 of 20 before and after).

### What to watch for after you upgrade

- A workspace rendered on OpenClaw before this release: run `gbrain bootstrap render --only AGENTS.md,HEARTBEAT.md --force` to write SCHEDULES.md and point AGENTS.md at it.
- `--all` still installs the full bundle on OpenClaw. Existing workspaces keep the skills they have.
- MCP clients that read `skills[].slug` from `list_brain_skillpack`, or `slug` from `get_skill` with `source_id`, read `name` instead. A skill name is the key `get_skill` takes; it was never a page slug.

### Itemized changes

- `src/core/bootstrap/render-host.ts`: `detectOpenClawWorkspace`, `resolveRenderHost` and the note render prints; `renderWorkspace` takes `host` (default `auto`), and an unknown host refuses with `unknown_host` before anything is written.
- `src/core/bootstrap/render.ts`, `templates/bootstrap/AGENTS.md.template`, `templates/bootstrap/HEARTBEAT.md.template`: the `openclawDest` template field and the `SCHEDULES_FILE` token.
- `src/commands/skillpack/harness.ts`: the OpenClaw core skill set as the default when no persona, skill or `--all` is given.
- `src/core/skillpack/brain-resident-locate.ts`, `src/core/shared-skills/compatibility.ts`: pack skills and skill detail carry `name`.
- Docs: INSTALL_FOR_AGENTS.md steps 5 and 6, docs/INSTALL.md, the personal-brain tutorial, the skillpacks-as-scaffolding guide, docs/mcp/TOOL_REFERENCE.md.
- Tests: `test/bootstrap-render.test.ts` (six render-host tests), `test/skillpack-scaffold-harness.test.ts` (OpenClaw default and `--all`), `test/skillpack-brain-resident-locate.test.ts` and the shared-skills transport cases (`name`, no `slug` key).

## [0.60.455.0] - 2026-10-25

**Sync reads a source repository owned by another Unix user once the operator allows it with Git's `safe.directory`. Before, it failed with "HEAD does not name a commit" however the directory was allowed.**

Sync reads a source checkout through a hardened Git environment that turns off system and global config and drops every `GIT_*` variable. Those are the three places Git reads `safe.directory` from, so Git refused the repository for dubious ownership, and the empty read surfaced as a missing HEAD. The hardened environment now carries the operator's `safe.directory` entries, from system config, global config and `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, in Git's order. Every other key in those places stays out, and the hardening arguments still apply. A config edit is picked up within 30 seconds. Other Git calls already read system and global config, and they now also keep a `safe.directory` set in the environment.

### Itemized changes

- `src/core/hardened-git.ts`: `hardenedGitEnvironment` adds the operator's `safe.directory` entries as environment config. System and global entries are read from `/` with `git config --includes --show-scope` (so no repository's config takes part) and cached for 30 s.
- `src/core/git-env.ts`: `envSafeDirectories` and `safeDirectoryEnv`; `gitChildEnv` keeps environment `safe.directory` entries and still drops every other `GIT_CONFIG_*` key.
- `test/hardened-git-safe-directory-7584.test.ts`: dubious ownership forced with Git's `GIT_TEST_ASSUME_DIFFERENT_OWNER` through a `git` wrapper on PATH. With no allowance the read is refused; a global, system or environment allowance lets it through; a `core.excludesFile` set beside the allowance is not applied; an allowance for another directory does not open this one.

## [0.60.454.0] - 2026-10-25

**On a git-canonical source, a page that turned private gets its file back when it turns world again.** Turning private still removes the page's file in a commit, so no commit holds private text. The page now remembers the path that file had, and when it turns world again the file is written back at that path. Before, a world concept republished without full provenance passed through a private step and lost its file for good, and any other page refused to turn world again (`source_changed`).

### What changed

| Situation | Before | Now |
|---|---|---|
| A file-backed page under a derive folder (`concepts/`, `atoms/`, ...) turns private, then world | it stayed database-only, and `gbrain sources git-gap` listed it as `declared.private` | its file is committed again at the path it had (`concepts/Some Idea.md` stays `concepts/Some Idea.md`) |
| Any other page on a git-canonical source turns private, then world | the write refused with `source_changed` ("the canonical file was removed outside coordinated publication") | the file is written back and committed |
| `synthesize_concepts` republishes a file-backed concept whose provenance does not yet cover its members | the private step removed the file and the world promotion published database-only | the world promotion restores the file |
| A private page whose folder was declared `db_only` since, published at world | kept its stale `private` class | stays database-only and drops the stale class |

### What to watch for after you upgrade

- Migration v274 adds the nullable column `pages.withheld_source_path`. Nothing is backfilled or rewritten on upgrade.
- Only sources converted to git-canonical (`sources.config.canonical = "git"`) are affected. Other sources behave as before.
- A page that turned private before this release has no recorded path. When it turns world, its file is written at the path its slug gives.

## [0.60.453.0] - 2026-10-25

**Large pages (over 1 MiB, stored in segments) now keep their links, mentions, timeline, fences, conversation facts and synopses per segment. A write reads only the segments it changed, an append reads only its new tail, and appending to a long conversation re-extracts facts for the new messages only. A sentence that a forced chunk cut used to split is now found whole by search. New transcript sessions import as one page. A page's new chunks go to the embedding provider once.**

### What changed

| Situation | Before | Now |
|---|---|---|
| Editing or appending to a large page | links, mentions, timeline entries and facts/takes fences were derived from the whole page | each is kept per segment; only changed segments (or the new tail) are read, with the same results. A rewrite of the whole page costs what it did before |
| Appending to a long conversation page | fact extraction re-read the conversation | only the new messages' windows are extracted; each fact records the window it came from (`facts.source_window`) |
| A conversation window whose extraction keeps failing for its own reason (malformed or truncated output, a refusal, input too long) | blocked the older windows behind it | after three runs in a row it is skipped with a receipt and `gbrain doctor` names it; the facts it had stay. Provider outages, auth errors and rate limits never count |
| A transcript whose format cannot be detected | the extractor guessed | all 22 built-in formats are counted: a page with no messages settles, one with messages is held (no calls, nothing deleted) with a `detection_ambiguous` receipt and doctor `conversation_detection_ambiguous`, until you choose: `gbrain extract-conversation-facts --source-id <s> --slug <slug> --grammar <format\|none> [--dry-run]` |
| Paying for fact, atom and synopsis extraction on a large page | counted against `embed.max_usd_per_page` | its own cap, `derive.max_usd_per_page` (default $2 per kind over the page's lifetime; unlimited under `spend.posture tokenmax` when unset; `off` disables it). `embed.max_usd_per_page` counts embeddings only. A model with no price records `unpriced_model`, and doctor `derivation_unpriced_model` names the `gbrain pricing set` command |
| `contextual_retrieval` set to `per_chunk_synopsis` on a large page | the page stayed on the title tier | each chunk gets a synopsis from the title, the page's first 8 KiB and up to 32 KB of its own segment; an unchanged window keeps its synopsis vectors |
| Long passages on large pages | a forced cut could split a sentence across two chunks | a forced cut lands on a sentence or line end, and timeline passages break only between bullet entries, so a top insert into a long timeline re-embeds at most 2 chunks. Existing pages move with `gbrain reindex --segmented` (preview first, `--apply` to run; never on upgrade). Inline pages are unchanged |
| A new transcript session | imported as part pages | one page up to the page ceiling. Existing split sessions keep stable parts and no longer rewrite every part when the session grows |
| Several writers embedding the same page | the post-write effect, `embed --stale`, the backfill job and phase-end embeds could each send the same chunks | a per-page lease means each chunk content version goes to the provider once |
| Forgetting or purging a fact on a large page | stored link, mention, timeline and fence results could still hold the claim | they are deleted with it. A fact purge also sweeps every stored result in the source that holds the claim (in its normalized form), in short batches. While a sweep is pending, derivation writes holding the claim are refused, and paid steps on covered pages wait (`purge_sweep_pending`). The receipt stays `pending` (exit 75) until nothing is left: `gbrain forget --purge --status --request-id <r> --continue` finishes it, and doctor `derivation_purge_sweeps` names it |
| Conversation facts from a private page | the segmented and managed paths could publish them as world | they stay private |

### What to watch for after you upgrade

- Migration v273 adds per-segment derivation watermarks (`page_segment_derivations`), `facts.source_window`, the per-page derivation spend ledger and the purge-sweep tables. It is additive. Nothing is re-extracted, re-chunked or re-embedded on upgrade.
- To move existing large pages to sentence-aligned chunks and bullet-aligned timelines, run `gbrain reindex --segmented`, read the preview, then add `--apply`.
- On the first transcript run after upgrade, existing transcript parts are rewritten once, with new titles and frontmatter.
- A held transcript page waits for your `--grammar` choice. Stale facts on it are not collected automatically.
- A pending purge sweep continues only with `--continue` or a later purge in the same source.

## [0.60.452.0] - 2026-10-25

**`search` and `query` take `source_ids`, so one request can be narrowed to the sources the person it serves may see on a shared brain, and the starter MCP tool list that harnesses re-fetch every turn is about 27% smaller: 19,489 bytes instead of 26,546 over stdio (35 tools) and 18,825 instead of 25,555 over HTTP (33 tools). The list only narrows; the token's grant stays the boundary. Every tool is still listed, and every parameter the starter list leaves out is still accepted and comes back from `request_tools {tools: [...]}`.**

### What changed

| Situation | Before | Now |
|---|---|---|
| An agent acting for one member of a shared brain searches | every source the token can read came back; only one `source_id` (or all) could be named | `source_ids: ["source-a", "source-c"]` (CLI `--source-ids source-a,source-c`) reads only those sources, in every arm: keyword, vector, title, other names, entity anchoring, saved facts, the CRAG re-run, think escalation and evidence delivery |
| A remote agent lists a source outside its grant | not possible | `permission_denied` for the whole request, as for `source_id`; a removed or archived source is `unknown_source` |
| `source_ids` with `source_id` | not possible | the request reads the sources in both; when none remain, nothing is searched and an `empty_retrieval` notice says why (never a fallback to the wider scope). An empty list or blank string is the same as omitting `source_ids` |
| Parameters on the starter tool list | every parameter except a few marked full-surface-only | the parameters an agent needs for the common call; params MCP callers cannot use (local-only, server-set provenance), legacy and duplicate params, admin and versioned skill-catalog params, image and code search params, and tuning or recovery knobs with safe defaults are left out (a refusal that needs one, such as put_page `allow_empty` or `drop_timeline`, names it) |
| Calling a tool with a parameter the starter list leaves out | accepted | still accepted, unchanged |
| `request_tools {tools: [names]}` on a server whose ceiling is `starter` | returned the starter schema, so the left-out params could not be discovered | returns each tool's full schema with every optional parameter |
| Memory verb descriptions | began with `MEMORY VERB (v1):` | the prefix is gone; tool names and the protocol are unchanged |
| verbs and full surfaces | | list every parameter as before (verbs 8,573 bytes, was 8,757) |
| A token with no source grant searches a brain whose pages all sit in sources that are not federated | `[]` with an `empty_retrieval` notice calling it a clean miss | `[]` with a `sources_not_readable` notice (kind degraded): the pages are in sources this connection cannot read, and the fix is `gbrain sources federate <source>` on the brain host, or a grant for the token. It never names a hidden source. Same for `query`, `recall` and `list_pages` |
| `gbrain sources add` without `--federated` or `--no-federated` | printed `federated: false` | also warns on stderr that a token or agent connection with no source grant cannot read the new source, and names the two commands that change that. The stored default is still non-federated |

### What to watch for after you upgrade

- For a bot acting for several members, give each member a token granted only that member's sources (`gbrain auth rescope --token <name> --sources <ids>`, or `--client <client_id>`); `source_ids` narrows inside a grant and is not a separation between members. See [multi-source brains](docs/guides/multi-source-brains.md#a-bot-acting-for-many-members).
- A schema-validating client on the starter surface with `mcp.strict_params reject` only sends parameters it was shown; fetch the full schema with `request_tools {tools: [name]}` or serve the full surface when an agent needs a left-out parameter.
- Access is per source, never per page. A bot answering everyone with one unscoped token over a single shared source exposes that whole source to every requester, and neither `source_ids` nor a search limit can narrow inside one source. Put content in one source per channel, team or member, and grant each member's token only its sources ([lay out sources by who may read them](docs/guides/multi-source-brains.md#lay-out-sources-by-who-may-read-them)).
- A token the operator granted sources, and every OAuth client (which always carries at least its bound source), never gets `sources_not_readable`: its scope is deliberate. A real miss inside a scope that holds pages gets no notice either.
- Nothing is rewritten on upgrade, and there is no schema migration.

## [0.60.451.0] - 2026-10-25

**A schema replay that loses a deadlock to a live reader now retries instead of failing (#6143), and four CI flakes are fixed at their cause: a darwin-x64 heartbeat left pending, test state leaking between files, an entity perf gate timed on wall clock, and a stress shard sized too small. No assertion or bound is loosened.**

### What changed

| Situation | Before | Now |
|---|---|---|
| `PostgresEngine.initSchema` (`init --migrate-only`, upgrade paths) chosen as a deadlock victim (40P01) by a reader holding `sources` and waiting on `pages` | the whole base-schema replay rolled back and the command failed with `deadlock detected` | the replay reruns, up to 3 attempts with 250/500 ms backoff and a stderr line; every other error behaves as before |
| A failed `gbrain orphans` / `find_orphans` (a policy read throws) | its 1 s progress interval kept running for the life of the process | the policy is read before the reporter starts, so nothing is left behind |
| A darwin-x64 native-locks cell whose runner cannot reach the GitHub API as it ends | `diag/native-heartbeat/darwin-x64/<bun>` stayed `pending` and held the PR unstable | a Linux `heartbeat-finalize` job posts the terminal state, naming the cell's real conclusion and its last heartbeat; contexts the cell finished itself are left alone |
| The `entity names with records` perf gate | wall-clock medians of 10 interleaved calls, so off-CPU time read as cost (one 51.8% read against the 50% ceiling) | the median of 20 alternating pairs of thread-CPU ratios; the ceiling stays 50% |
| Stress gate shards holding `entity-card-perf.slow.test.ts` | estimated at 120 s per iteration, so 10 iterations (about 246 s each) overran the 35-minute shard | the measured 246 s weight splits them across two shards |

### Itemized changes

- `src/core/postgres-engine/schema-lock-timeout.ts`: `retrySchemaReplayOnDeadlock`, used by `initSchema`. Forced probe `test/schema-replay-deadlock-6143.test.ts` (a Postgres unit arm): 3 of 3 deadlocks before, 3 of 3 clean after.
- `.github/workflows/native-locks.yml`, `scripts/native/heartbeat-finalize.ts`: the watcher job (`actions: read`, `statuses: write`, no-op on forks). `scripts/native/heartbeat.sh` logs each failed post's curl exit code and HTTP status, never a token or body.
- Test leaks fixed: output capture in `cli-socket` and `cli-socket-context` tests, overlapping `withEnv` frames, console bindings after the stderr redirect, and a `process.exit` stub. New isolation lint R9 requires any test that installs a process-global hook to undo it.
- `test/entity-card-perf.slow.test.ts`: the records gate reads thread CPU in alternating pairs. Forced probe (400 ms off-CPU on 70% of the references calls): old gate 100%/164% red, new gate 22%/26% green.
- `scripts/stress/iteration-weights.json`: the measured stress weight for `entity-card-perf.slow.test.ts`.
- `test/e2e/persistence-idle-pool.test.ts`: the drain checks count client backends only, so an autovacuum worker on the scratch database no longer reads as a pooled connection. Forced probe (aggressive autovacuum): 4 backends red before, green after.

## [0.60.450.0] - 2026-10-25

**A git-canonical source now has declared database-only classes: private, alias-private and lineage-private pages, pages under a `storage.db_only` directory, never-filed derive-phase pages and paths Git ignores keep no file in Git on purpose, and any other write that would land in the database alone is refused. A page turning private is published as the Git commit that removes its file. The mode stays off by default and nothing turns it on yet.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A page write on a source with `config.canonical = "git"` that belongs to a declared class (private, alias-private, lineage-private, `storage.db_only` directory, never-filed derive folder, ignored path) | a file was written and committed, or refused `git_target_ignored` | no file is written, no commit is made and no Git effect is queued; the row records its class in `database_only_reason` (`private`, `alias_private`, `lineage_private`, `git_ignored`) |
| A file-backed page of that source turning private | its file was rewritten with the private bytes | the door commits the removal of its file (also when only HEAD still has it) and the same publication clears `source_path`/`source_uri`, so a later sync keeps the page live and private |
| A publication of that source that would commit a private page's bytes (the page or its origin turned private after the write was prepared, a managed import of a private file) | committed | refused `git_private_commit_refused`, nothing written and HEAD unchanged; a group with one such member is refused whole |
| A publication of that source that would write a declared page's file, or store an undeclared page with no file | not checked | refused `git_home_required` |
| A file under a `.gitattributes` rule `filter=lfs` on that source | committed through whatever filter the checkout had | refused `git_lfs_not_enabled` unless `storage.git_lfs` is on (new key, default off) and the checkout configures the LFS filter; then the door commits the LFS pointer |
| A row write to that source by a writer that does not declare the git protocol (an older gbrain) | accepted | refused by the managed writer guard (`git_protocol_required`) |
| `gbrain sources git-gap` on a source without a checkout | its pages were counted as not compared | they are declared `database_only_source` (a whole-source class, outside strict mode) |

### What to watch for after you upgrade

- Migration `git_canonical_declared` adds a one-row counter of git-canonical sources and replaces the managed writer guard function. Nothing is backfilled or rewritten, and while no source is git-canonical the new guard branch refuses nothing.
- Hashing an LFS-routed file stores its object in `.git/lfs/objects` before the publication commits; a publication that rolls back can leave that object behind, unreferenced and harmless.

## [0.60.449.0] - 2026-10-25

**Search and query answer `response.meta` about 560 ms faster on a large sealed brain when the process has no cached readiness answer (every `gbrain search` or `gbrain query` CLI call): the projection-readiness probe reads the small pending-projection index instead of every page.**

### What changed

| Situation | Before | Now |
|---|---|---|
| The first searches after a Postgres restart on a brain whose HNSW index is not cached | each new query read 2,000 to 4,500 uncached index pages (vector stage 1.4 s median, 3.0 s p95 on a 600k-page soak brain with an 11 GB index) | an operator can run `gbrain embeddings prewarm` (or set `serve.vector_prewarm true` to run it at each serve start, off by default) to load the HNSW indexes into `shared_buffers` with `pg_prewarm` first: 50 s for 11 GB, then a 41 ms median vector stage (1.9 s p95) on the same queries |
| `gbrain embeddings prewarm` when the indexes exceed half of `shared_buffers`, or `pg_prewarm` is missing | - | it refuses before reading any index page (`vector_prewarm_wont_fit` with the `shared_buffers` size it needs, `vector_prewarm_extension_missing`); `--dry-run --json` shows the fit. `effective_cache_size` is reported, never used |
| The readiness probe on a brain with no pending text projections | the planner, with no statistics for the revision comparison, expected most pages to be pending and scanned all of `pages` (199k buffers, ~600 ms at 600k pages) | each arm orders by `idx_pages_projection_pending`'s columns under `LIMIT 1`, so it reads only that partial index (under 1 ms) |

### What to watch for after you upgrade

- Answers are unchanged: the probe returns the same `ready`, `projection_pending`, `by_design` or `unknown` status, and output, defaults and notices are the same.
- Nothing is rewritten on upgrade, and there is no schema migration (the index arrived with migration 161).
- Vector prewarm is opt-in: nothing runs unless you call it or set `serve.vector_prewarm`. It is a local operator command (no MCP tool; thin clients and PGLite brains are refused), it needs `CREATE EXTENSION pg_prewarm` once, and prewarmed pages stay cached only until Postgres restarts or other reads evict them. See docs/ENGINES.md#vector-index-prewarm.

## [0.60.448.0] - 2026-10-25

**A test flake is fixed: the D-23 control test waits for an atom batch's requests to finish before it reads their outcome. Product behaviour is unchanged.**

The test stopped the persistence consumer and read the refusals right after the second extract run returned. That run returns at its edited atom's `source_changed` refusal, while the batch's completion request is still publishing. So the completion's `revision_conflict` ("The atom batch is not fully committed.") was sometimes there and sometimes not. That refusal is correct: a batch whose atom did not commit is not marked complete, and a later drain refuses again without a model call. The test now waits out the source's queued and running requests before each read. It pins both settled refusals in order, and it checks that no request is left running.

### Itemized changes

- `test/pathological/d23-extract-atoms-db-only.test.ts`: a `settle` helper (wait out queued and running requests, then dispose) replaces each bare dispose in the control test; the final assertion pins the atom's `source_changed` and the completion's `revision_conflict` with its message.

## [0.60.447.0] - 2026-10-25

**A strict (`canonical: git`) source now commits each write to Git with plumbing, without rewriting the checkout's index. On a 150k-file checkout the door costs about 230 ms per write instead of about 830 ms. Strict mode is still off by default, and nothing turns it on.**

Before this release the door used a porcelain `git commit --only`. That refreshes and rewrites the whole index on every write, so its cost grows with the size of the checkout. The door now writes the commit directly: it hashes the published files, rebuilds only the trees along the changed paths from HEAD, writes the commit, and moves the branch with a compare-and-swap. It then updates the index for exactly the published paths and leaves every other entry alone.

### What changed

| Situation | Before | Now |
|---|---|---|
| A strict write's Git commit | `commit --only`, which refreshes the whole index | a plumbing commit; the index changes only for the published paths |
| The branch moves during the commit (a commit made in the checkout) | the porcelain commit took the new HEAD as its parent | the commit is rebuilt once on the new HEAD; a second move refuses and the write rolls back |
| Door overhead, 150k files (p50 / p95) | 825 / 925 ms | 229 / 260 ms |

A strict write on a detached HEAD or an unborn branch is refused with `git_detached_head` or `git_branch_unborn`, and the write rolls back. Commit message, trailers, author and tree are the same as the porcelain path produced. An ignored new target still refuses with `git_target_ignored`. A batch still commits once.

### Itemized changes

- `src/core/persistence/git-door.ts`: the plumbing commit (`hash-object -w`, a tree rebuild from HEAD, `commit-tree`, `update-ref` compare-and-swap, a targeted `update-index`). Door commits on one checkout run one at a time in this process.