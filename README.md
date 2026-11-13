# n8n unknown write outcome

[![test](https://github.com/feversoul/n8n-unknown-write-outcome/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-unknown-write-outcome/actions/workflows/test.yml)

An n8n workflow sends a write to an API and the request times out. The write may have landed. The API has no idempotency key, and its lookup can lag, so "not found" proves nothing. These workflows handle that case: the write goes out once, the outcome is kept as `unknown`, a scheduled check looks it up a bounded number of times, and after the cutoff a person is asked. They never send again because something was absent or because time ran out.

Built-in nodes and **Data Tables** only: no external database, no community nodes.

Everything was run on n8n 2.47.7 against the [lost-ack fixture](third_party/README.md) that was shared in the forum thread this comes from. The fixture counts write attempts and effects on its own side. No real API was called.

| Asked for                                                 | What you get                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What evidence do you wait for before sending again?       | Only an authoritative receipt: for this reference, for this attempt, terminal, `not_applied`. Then one resend, claimed in the row first. A 404, an empty or odd 200, an error or a timeout are not evidence. |
| Keep the job pending and recheck, or hand it to a person? | Both. `unknown` jobs are looked up after 60, 300 and 900 seconds (your numbers). Still nothing: `review`, and an alert with reference, payload, send time and every lookup.                                  |
| The record that shows up after the cutoff                 | Jobs in `review` are still looked up, every 30 minutes. When the record appears the job is closed and a second alert says "resolved itself, do not enter it again".                                          |
| Measure the settle window instead of guessing             | Every row keeps `sent_at` and `first_seen_at`.                                                                                                                                                               |
| Two runs of the same job, an n8n restart mid-wait         | A reference is claimed in the table before the write. All state is in the table and the checks run on a schedule, so there is no Wait node to lose. Both were tested.                                        |

## How it works

One data table, `write_jobs`, one row per write:

```
            2xx                                    record found
sending ──────────▶ done ◀───────────────────────────────────────┐
   │  4xx                    ▲ record found                      │
   ├──────▶ rejected         │                                   │
   │  no answer, 5xx         │        cutoff reached             │
   └──────▶ unknown ─────────┴──────────────────────▶ review ────┘
               │  ▲                                  (still looked up,
               │  └── resend answered nothing         never written again)
               ▼
        receipt: not_applied, this reference, this attempt
               └── claim ──▶ sending (attempt 2) ──▶ done
```

Three workflows:

- **0 Setup** creates the table. Run it once.
- **1 Write** takes `{ reference, target, payload }` from an Execute Sub-workflow node or a webhook. It writes the row first, sends the write once with Retry On Fail off, and records what came back. With no answer the job is `unknown` and this workflow is finished. A reference that already has a row is answered from the row; nothing is sent.
- **2 Check** runs every minute. For each open job that is due:
  1. Look it up by the reference. Exactly one record with an id is a match: `done`.
  2. No match and the job is `unknown`: ask for a receipt. If the receipt proves the write was not applied, claim the resend with one conditional update, send, record.
  3. Otherwise count the check. After the last recheck the job becomes `review` and the alert goes out.
  4. Jobs in `review` are only looked up. A late match closes them (`arrived_after_cutoff`) and sends the second alert.

`reference` is your own id for the write. The API must store it in a field its lookup can search by. Without that there is nothing to recheck.

How a job ended is in `resolution`: `acknowledged` (the write got its 2xx), `confirmed_by_lookup`, `resent_after_receipt`, `arrived_after_cutoff`, `refused_<code>`, `several_records` (more than one record under the reference; goes to `review`). `history` holds every write, lookup and receipt with its time and what came back.

## Add it to your n8n

Data Tables are available on n8n Cloud. I did not test on Cloud itself.

1. Create a **Header Auth** credential named `Unknown Write Key` (header `X-Workflow-Key`, any long random value). The webhooks use it.
2. Import the three files in `workflows/` (Workflows > Import from File) and pick the credential on the webhook nodes.
3. Open **Unknown Write · 0 Setup** and press **Execute workflow** once. It creates the data table `write_jobs`.
4. In **1 Write**, replace **Send the write** with your own request. Put the reference in a field the API stores. Keep **Retry On Fail** off and **On Error** on _Continue_. Set its timeout. Adapt `readWrite` in **Read the answer** if a 2xx/4xx means something else at your API.
5. In **2 Check**:
   - Replace **Look it up** with your search by reference, and adapt `records` in **Judge the lookup**. Keep the rule strict: only a positive match counts.
   - If your API has an answer that proves a write was not applied, point **Ask for a receipt** at it and adapt **Judge the receipt**. If it has none, set `USE_RECEIPT = false` in **Settings**. Then nothing is ever sent twice.
   - Set `RECHECK_AFTER_SECONDS`, `REVIEW_RECHECK_SECONDS` and `ALERT_URL` in **Settings**. The alert is a JSON `POST` with `event` (`needs_review` or `resolved_itself`), `text`, `reference`, `payload`, `sent_at`, `history`. Point it at a workflow that posts to Slack or mail, or replace **Send the alert** with the node you use.
   - **Send the write again** must be the same request as in step 4.
6. Publish 1 and 2. Send writes from your own workflow with an **Execute Sub-workflow** node on **1 Write**, or `POST /webhook/unknown-write/submit`.

`GET /webhook/unknown-write/jobs?status=review` is the review list; `?reference=...` shows one job. When a person has settled a job by hand, set its row to `done` in the data table so the checks stop.

For the cutoff: after a few weeks, compare `sent_at` and `first_seen_at` of the rows that ended `confirmed_by_lookup`. `first_seen_at` is when a check first saw the record, so it is only as fine as your recheck steps.

## What was tested

`npm run test:e2e` and `npm run test:e2e:postgres`, each from a fresh stack, n8n 2.47.7. Test timing: the write gives up after 400 ms, rechecks 1 s apart, cutoff after 3, review rechecks every 1 s. The numbers are the fixture's own report for the reference.

| Case                                                                                  | Job ends as                  | Write attempts | Effects    |
| ------------------------------------------------------------------------------------- | ---------------------------- | -------------- | ---------- |
| Control without the workflows: write again after the first 404                        | (duplicate)                  | 2              | 2          |
| `committed`: write landed, two 404s, then visible                                     | `done`, confirmed by lookup  | 1              | 1          |
| `uncommitted`: write never landed, 404 forever                                        | `review`, one alert          | 1              | 0          |
| `stale-json`: `200 {"exists":false}` twice, then visible                              | `done`, confirmed by lookup  | 1              | 1          |
| `malformed-json`: `200 {}` and `200 {"exists":"false"}`, then visible                 | `done`, confirmed by lookup  | 1              | 1          |
| `confirmed-no-write`: 404, receipt says `not_applied` for attempt 1                   | `done`, resent after receipt | 2              | 1          |
| `committed`, hidden for 5 lookups (past the cutoff)                                   | `review`, then `done`        | 1              | 1          |
| `stale-json`, hidden for 5 lookups                                                    | `review`, then `done`        | 1              | 1          |
| `malformed-json`, hidden for 5 lookups                                                | `review`, then `done`        | 1              | 1          |
| One reference submitted 4 times at the same instant, 8 rounds                         | `done`, one row              | 1 per round    | 1          |
| 6 Check runs at once, repeated, while the receipt allows a resend, 8 rounds           | `done`                       | 2 per round    | 1          |
| A write the API answers with 400                                                      | `rejected`, no lookups       | not counted    | 0          |
| n8n restarted with four jobs open (`committed`, `uncommitted`, receipt, hidden for 5) | as in the rows above         | 1, 1, 2, 1     | 1, 0, 1, 1 |

| Run                           | Result          |
| ----------------------------- | --------------- |
| n8n with SQLite (its default) | 13 of 13 passed |
| n8n with PostgreSQL           | 13 of 13 passed |

In the three "hidden for 5 lookups" rows the reviewer's sink received exactly two alerts per job, `needs_review` and then `resolved_itself`. In the `uncommitted` row the job was looked up three more times while in review and the write count stayed at 1.

The fixture's own test file also passes (3 of 3, run in a container).

## What was not tested, and other limits

- **The API is a fixture.** Its lookup, its lag and above all its receipt endpoint are synthetic. A real API's ordinary search is not a receipt. If yours has nothing authoritative, turn the receipt step off.
- n8n Cloud, queue mode, versions other than 2.47.7.
- A receipt for an earlier attempt after a resend that also got no answer. The rule is in **Judge the receipt** (the attempt number must match), but the fixture always answers its second write, so that path did not run. Same for a receipt that names another reference.
- An n8n process that dies between claiming the row and getting the answer. The row stays `sending`; after `LEASE_SECONDS` the Check workflow treats it as `unknown` and only looks it up. That path did not run. The restart test restarted n8n while the jobs were `unknown`.
- After the restart each open job got 13 to 18 lookups where 3 to 6 were expected: n8n started many Check runs close together (with the 1-second test schedule). Writes stayed correct, but because of that burst the record that was hidden for 5 lookups was found before the cutoff instead of after it. Runs that overlap can also undercount `checks` and drop entries from `history`. They cannot cause a second write: the resend is one conditional update, and that is the case the "6 Check runs at once" test hammers.
- The fixture takes no request body, so the payload is stored in the row and the alert but was not sent.
- A person who re-enters a record by hand while the original is still on its way creates a duplicate that these workflows cannot prevent. The alert text says to search by the reference first, and `several_records` flags it at the next lookup if both carry the reference.
- Data Tables have no unique constraint. A new reference is claimed by "insert, then the lowest row id wins". That held for 4 simultaneous submits, 8 rounds, on both databases.
- Rows are never deleted. Up to 50 open jobs are handled per run (`MAX_PER_SWEEP`).

## Run the tests yourself

```sh
git clone https://github.com/feversoul/n8n-unknown-write-outcome
cd n8n-unknown-write-outcome
npm run test:e2e            # n8n on SQLite
npm run test:e2e:postgres   # n8n on PostgreSQL
```

Needs Docker and Node 20 or newer. `KEEP_STACK=1` leaves the stack up: the editor is on http://localhost:55686, the fixture's report on `http://localhost:58088/lag2/<scenario>/report?ref=<reference>`.

To look around by hand: `cp .env.example .env`, fill it in, `docker compose up -d`. The workflows then use their real defaults (60, 300 and 900 seconds).

The fixture in `third_party/lost-ack-fixture` is third-party code under its own MIT license, copied unchanged; see [third_party/README.md](third_party/README.md). It runs only inside its container.

After changing `scripts/build.mjs`, run `npm run build` to write `workflows/*.json` again.

## License

MIT. The fixture in `third_party/` keeps its own license file.
