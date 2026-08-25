# CSV → Personalized Email Generator

Upload a CSV of contacts, map its columns, write a template with merge
variables, optionally have Claude personalize each row individually, **review
every generated email**, then send from your own Gmail — throttled, compliant
and auditable.

> **Status: Phase 2 of 9.** Scaffold, database, auth, CI, CSV import, and the
> template engine with live preview are done — the app is already usable
> end-to-end in template-only mode, with no AI key. The build plan is in
> [Roadmap](#roadmap); `/campaigns` shows live progress.

**Setup instructions → [SETUP.md](SETUP.md)**

---

## What makes this different from a script that loops over rows

| | A loop over rows | This |
|---|---|---|
| Sending | SMTP in a `for` loop | Queued, throttled, retried, idempotent |
| Review | blind send | Human approval gate on every email |
| Compliance | none | One-click unsubscribe, suppression list, dual profiles |
| Failure | dies at row 400 | Per-row state machine; resumes, never double-sends |
| Cost | unknown | Metered from real API usage, with a hard spend cap |

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16, React 19, TypeScript | One deployable, Server Components, no separate API |
| Styling | Tailwind v4 | Theme tokens in `globals.css`, light + dark |
| Database | Postgres via Supabase (local Docker) | Real JSONB, arrays, partial indexes, `timestamptz` |
| Queries | Drizzle ORM | Typed SQL, real migrations, raw SQL when needed |
| Auth | Supabase Auth (Google) | Sign-in and mailbox connection in one consent |
| Sending | Gmail API | Sends as you; replies thread naturally |
| AI | Anthropic, **bring your own key** | ~$1 / 1,000 emails; app never ships a key |

### Why Drizzle *and* the Supabase client

Supabase's JS client is PostgREST underneath, and PostgREST cannot express
`SELECT ... FOR UPDATE SKIP LOCKED` — the primitive the job queue depends on.
So the split is strict:

```
Supabase JS client  →  auth only (sign in, session, sign out)
Drizzle + postgres.js →  every query, every migration, the queue
```

Both talk to the same database. Studio still shows everything, because it is
just Postgres.

### Why Drizzle owns migrations

`supabase/migrations/` is deliberately empty. Two migration systems against one
database is a reliable way to corrupt schema history, so Drizzle is the single
authority and the Supabase CLI only runs the local stack. Policies and the
foreign key into Supabase's `auth` schema live in a hand-written Drizzle
migration ([`drizzle/0001_rls_and_auth.sql`](drizzle/0001_rls_and_auth.sql)),
guarded so it also applies to plain Postgres in CI.

---

## Architecture

```
BROWSER — Next.js App Router
  CSV is parsed client-side; the raw file is never uploaded
        │  Server Actions · Route Handlers
        ▼
src/core/ — pure TypeScript, zero framework imports, unit-tested
  csv · template · ai · review · compliance · gmail
        │
        ├──▶ Postgres (Supabase)   schema, queue, audit log
        ├──▶ Anthropic API         user's key · Haiku 4.5 · cache · batch
        └──▶ Gmail API             user's OAuth · 500/day · threading
        ▲
        └── WORKER  `npm run worker` — plain Node process, claims jobs with
                    FOR UPDATE SKIP LOCKED. Kill it and restart; nothing
                    duplicates and nothing is lost.
```

Everything meaningful lives in `src/core/` with no Next.js imports. That is
what keeps it testable, and what would let the same engine drive a CLI later
without a rewrite.

---

## Design decisions worth knowing

**AI fills slots, not emails.** `{{ai:opening}}` is a bounded insert with its
own brief and guardrails. You keep the structure and the call to action; the
model writes only the part that must vary. That is what makes output
consistent, reviewable, and cheap — the surrounding prompt is byte-identical
across every row, so prompt caching bills it at 10%.

**Merge values are never re-parsed.** A CSV cell containing `{{ai:opening}}`
renders as those literal characters. It cannot inject a slot, open a
conditional, or reference another variable. Same rule in HTML: values are
escaped before markup is added, so `Smith & Sons` and `<b>Acme</b>` are safe.

**One source for text and HTML.** The template is authored as plain text and
the HTML part is derived from it. Maintaining a second HTML template is how the
plain-text alternative of a multipart message ends up stale or empty.

**Nothing sends without human approval.** Generated emails land in `generated`
or `flagged`, never `approved`. The send path only reads `approved` rows.

**Two compliance profiles.** `one_to_one` sets `List-Unsubscribe` and
`List-Unsubscribe-Post` headers plus a soft opt-out line — no newsletter
footer on a personal email. `bulk` adds the full CAN-SPAM footer. Both enforce
the suppression list **at dispatch time**, so someone who unsubscribes
mid-campaign is still dropped.

**No open tracking.** Gmail provides none natively, and a tracking pixel on 1:1
outreach costs more in deliverability and trust than the data is worth. Reply
rate is the metric.

**Credentials are encrypted with AES-256-GCM**, bound to the owning user via
AAD — a credential row copied onto another user fails to decrypt rather than
leaking a working token. See [`src/lib/crypto.ts`](src/lib/crypto.ts).

---

## Layout

```
src/
  app/
    (auth)/login/          sign in with Google + gmail.send
    (app)/                 authenticated shell
    auth/callback/         OAuth callback — captures the refresh token
  core/                    pure logic, framework-free
    csv/                   parse · detect · validate · dedupe · sanitize
    template/              parse · render · html · validate
    gmail/scopes.ts
  db/
    schema.ts              13 tables
    index.ts               pooled runtime client (prepare: false)
    migrate.ts             direct-connection migrator
  lib/
    crypto.ts              AES-256-GCM + unsubscribe HMAC
    supabase/              browser · server · proxy clients
    auth/                  Google credential ownership
  proxy.ts                 session refresh + route gate (Next 16: was middleware.ts)
drizzle/                   migrations — the single source of truth
tests/                     Vitest
```

---

## Roadmap

| Phase | | Deliverable |
|---|---|---|
| 0 | ✅ | Scaffold, database, Google auth, CI |
| 1 | ✅ | CSV upload, column mapping, validation, dedupe |
| 2 | ✅ | Template engine, live preview (no AI needed) |
| 3 | | AI slots, BYO key, guardrails, live cost meter |
| 4 | | Job queue, worker, Batch API generation |
| 5 | | Review screen, flags, approval gate |
| 6 | | Gmail send, idempotency, throttle, quota |
| 7 | | Unsubscribe, suppression, preflight |
| 8 | | Bounce detection (opt-in), reporting |
| 9 | | Playwright E2E, docs, deploy |

---

## Known constraints

1. **Gmail caps at 500 recipients/day** (2,000 on Workspace), on a rolling 24h
   window. Correct for 1:1 outreach; wrong for newsletters. Adding another
   provider later is one adapter file.
2. **The worker only runs while your machine is on.** The queue is durable, so
   closing the laptop pauses a campaign and reopening resumes it exactly where
   it stopped. Unattended sending would need a small VPS running the same
   stack — a deployment change, not a code change.
3. **Free-tier Supabase Cloud projects pause after ~1 week idle.** Irrelevant
   while local.

---

## Contributing

```bash
npm run check    # typecheck + lint + format + test
```

CI runs the same checks plus a migration-drift guard that fails if
`src/db/schema.ts` changed without a generated migration.
