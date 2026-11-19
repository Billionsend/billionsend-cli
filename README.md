# @billionsend/cli

Moves an email account to [BillionSend](https://billionsend.com): contacts, segments, topics, properties, templates, webhooks, domains and suppressions. Reads from the source provider, writes to your BillionSend account, and is safe to run again — a second run right before cutover syncs what changed since the first.

```sh
npx @billionsend/cli migrate --from resend                    # interactive: connect, choose, plan, confirm, apply, summary
npx @billionsend/cli migrate plan --from resend --out plan.json   # read-only; exit 0 nothing to do, 2 changes, 1 error
npx @billionsend/cli migrate apply plan.json --yes
npx @billionsend/cli migrate status
npx @billionsend/cli migrate rollback                         # deletes only what the tool created
```

Node 18 or newer; no dependencies.

## What moves

| Resource                     | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contacts                     | Upserted by email through the batch endpoint; `unsubscribed` and topic opt-outs are preserved, never re-subscribed. Resend's `unsubscribed` is global, so it lands as BillionSend's team-wide `unsubscribed: true`; no per-domain unsubscribe is created. Topic subscriptions and properties follow in two per-contact passes that run after everything else, so the account is sendable before they finish. The batch endpoint answers created, updated or skipped but never whether a matched contact changed, so the summary reports those as `matched existing`, not as updated or unchanged.                                                                                                                                                                                                                                                                                                                                             |
| Segments, topics, properties | Matched by name / name / key: created when missing, updated when different, left alone when equal. Segment memberships follow the contacts. BillionSend property keys ignore case, Resend's do not: when Resend has both `plan` and `PLAN`, only the first is created, the other is listed as a manual note, and the report counts the contacts whose value for it was not written. A key that differs only in case from one already on BillionSend is the same property, and values are written under the spelling it has.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Templates                    | Name, alias, subject, html, text, default from, reply-to and variables (up to 50 reply-to addresses and 50 variables; what does not fit is listed as a manual note).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Webhooks                     | Endpoint and events. Signing secrets are copied so receivers keep verifying (`--fresh-webhook-secrets` mints new ones, shown once). Events BillionSend also emits carry over (`email.*`, `contact.created`, `contact.updated`, `contact.deleted`, `contact.topics.updated`, `suppression.added`, `suppression.removed`, `domain.created`, `domain.updated`, `domain.deleted`, `topic.created`, `topic.updated`, `topic.deleted` and `inbox.*`); the rest are dropped per webhook and listed. `email.scheduled`, `email.failed` and `email.suppressed` carry over only to an instance that emits them (its `GET /openapi.json` lists them). An older one refuses those webhooks with a 422: migrate to it with `npx @billionsend/cli@0.2.3`, which drops the three along with `suppression.added` and `suppression.removed` and lists all five; add those two back to the webhook afterwards, in the dashboard or with `PATCH /webhooks/{id}`. |
| Suppressions                 | Bounces, complaints and manual entries, with their origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Domains                      | Created with return path and tracking settings, in the one SES region your BillionSend instance serves (BillionSend Cloud: `us-east-2`) — the Resend region does not carry over. DNS records must be added again (DKIM keys are per provider); the report prints a copy-ready table. Both providers can stay verified side by side. Resend has no unsubscribe subdomain or page, so those are left unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Broadcasts                   | Drafts and scheduled ones import as drafts; sent ones are skipped unless `--include-sent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| API keys                     | Not recreated (the source only exposes names); the report lists them as a to-do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Audiences (deprecated in Resend) are skipped — segments cover them.

## Environment

| Variable               | Meaning                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`       | Source key (full access; the tool only ever reads). Alternatives: `--from-key-stdin`, or a masked prompt in a terminal.         |
| `BILLIONSEND_API_KEY`  | BillionSend key (full access). Alternatives: `--to-key-stdin`, or a masked prompt.                                              |
| `BILLIONSEND_BASE_URL` | BillionSend API URL. Same as `--to-url`. Unset, the target is BillionSend Cloud (`https://api.billionsend.com`), like the SDKs. |
| `NO_COLOR`             | Disables ANSI colors.                                                                                                           |
| `DO_NOT_TRACK`         | Honored as a no-op: the tool sends no telemetry, never phones home and never checks for updates.                                |

## Flags

`billionsend --help` lists every flag. The ones that change what happens:

- `--only a,b` / `--skip a,b` — resource names: `domains, properties, topics, segments, contacts, enrichment, broadcasts, templates, webhooks, suppressions, api-keys`. `enrichment` is the per-contact pass (topic subscriptions, then properties) that runs last.
- `--segment name|id` — only these Resend segments (repeat the flag or separate with commas): the segments themselves, their members (read from each segment's own member list) and those members' enrichment. A name or id that does not exist stops the run with exit 1 and lists the segments on the account. Broadcasts sent to a segment outside the selection are skipped. The plan and the report name the scope.
- `--rps N` — requests per second against the source (default 8). Resend's team limit is 10, shared with your production sending; the CLI prints the limit it detects and warns above it. Go past 10 (up to 100) only after Resend raised your limit.
- `--on-conflict upsert|skip|error` — contacts that already exist on the target (default `upsert`).
- `--include-sent`, `--fresh-webhook-secrets`, `--fresh` (ignore the state file).
- `--yes`, `--non-interactive` (automatic when stdin is not a terminal), `--json` (JSON on stdout, progress on stderr), `--verbose`, `--color auto|always|never` (`--no-color` = `never`).

`migrate plan --out plan.json` records the options that decide the plan's content (`--only`, `--skip`, `--segment`, `--on-conflict`, `--include-sent`, `--fresh-webhook-secrets`). `migrate apply plan.json` follows them: leave those flags out, or give the same values; a flag that disagrees with the file stops the run with an error. If the plan built from the file's options still differs from the file, the source or your BillionSend account changed since it was made, and the message names the items that differ. `--report <file>` writes the Markdown report there; with `migrate plan` it writes the plan as a Markdown report. The plan looks up the source's contacts on BillionSend by address (one request per 1,000) and lists the ones that are new apart from the ones already there. Whatever the run does, an opt-in is never written over an opt-out the contact made on BillionSend.

Exit codes: 0 ok · 1 error · 2 plan has changes (`plan` only) · 3 partial, some items failed (details in the report).

## Files

`.billionsend/migrate-state.json` (every id created, resume cursors, the plan hash) and `.billionsend/migrate-report.{json,md}` are written next to where you run the tool, mode 0600. `.billionsend/` is appended to `.gitignore` when one exists there. No file ever contains a key.

## Security

Your Resend key never leaves your machine — the tool only ever contacts `api.resend.com` and your BillionSend API. Against Resend it sends GET requests only, to documented endpoints. Keys live in memory for the duration of the run: they are never written to a file and are redacted from every log line. There is no telemetry, no update check, no third party.

## Re-running and rolling back

Every run is a diff: properties, topics, segments, domains, templates and webhooks are updated when they differ and left alone when they match. Contacts are upserted; the API does not say whether a matched contact changed, so the summary counts them as `matched existing`. Run `billionsend migrate --from resend` again right before cutover to sync the contacts that arrived in between.

A `429` is waited out on every request, as long as `Retry-After` asks (seconds or an HTTP date) up to 60 seconds; a longer wait is an error. A `5xx`, a timeout or a lost connection is tried again only for reads and deletes; a write (create, update, batch) is sent once, because it may have gone through, and a failure is recorded in the summary: run the command again and it continues from where it stopped.

`billionsend migrate rollback` deletes only the ids the tool created (never rows it merely updated), in reverse dependency order, after showing the list and asking for confirmation. Bounce and complaint suppressions are permanent on BillionSend: rollback leaves the ones it added in place and says so.

## Development

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

The tests never reach a real account. The source side is a fake account (`test/helpers/fake-resend.ts`); the BillionSend side is a contract API (`test/helpers/contract-api.ts`): an in-memory API that checks every request the CLI sends and every answer it gives against the published OpenAPI document, kept in `openapi/api.openapi.json`. A request to an undocumented path or with an undocumented parameter, a body off its schema, or an answer the document does not describe fails the test that caused it.

`pnpm openapi:sync` refreshes the snapshot from https://billionsend.com/docs/api.openapi.json (`-- --from <file|url>` takes another source, `-- --check` only compares); run the tests after it, and what fails is what the CLI has to follow. CI compares the snapshot with the published document on every push and pull request and every day.

## Releasing

Publishing is manual; nothing is published on push.

1. Set `version` in `package.json`, commit, then tag and push: `git tag v0.3.1 && git push origin main v0.3.1`.
2. The first version only: a member of the `@billionsend` npm organization publishes from a clean checkout of the tag, with two-factor authentication: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && npm publish` (`prepublishOnly` builds the bundle; `publishConfig.access` is `public`).
3. Once the package exists: on npmjs.com, `@billionsend/cli` → Settings → Trusted Publisher → GitHub Actions, repository `billionsend/billionsend-cli`, workflow `release.yml`.
4. Every later version: Actions → `release` → Run workflow, on the version tag. The workflow refuses a branch or a tag that differs from `package.json`, runs every check, and publishes with npm Trusted Publishing (no token stored).

## License

MIT

---

Resend is a trademark of Plus Five Five, Inc. BillionSend is not affiliated with or endorsed by Resend.
