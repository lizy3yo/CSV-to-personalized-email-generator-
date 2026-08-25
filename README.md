# CSV → Personalized Email Generator

Upload a CSV of contacts, map its columns, write a template with merge
variables, optionally have Claude personalize each row individually, **review
every generated email**, then send from your own Gmail — throttled, compliant
and auditable.

> **Status: Phase 8 of 9.** Feature-complete: import contacts, write a
> template, generate in the background, review and approve, send from your own
> Gmail — throttled, quota-aware, compliant — then see bounces, replies and
> rates on the report. Only end-to-end tests and deployment docs remain.
> The build plan is in [Roadmap](#roadmap).

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

**The cached prefix is the cost model.** The system prompt — task, template,
brief, guardrails — is byte-identical for every recipient, so it is cached once
and billed at a tenth of the input rate thereafter. Only the recipient's own
fields vary. Letting anything row-specific reach the system prompt would
invalidate the cache on every call, which is the most expensive mistake
available in this codebase; the prompt builder takes no row data at all.

**Spend is measured, not estimated.** Every response's `usage` block is written
to `ai_usage` and summed. The estimate shown before generation is labelled as
one; the number under "Actual usage" is what you were billed.

**Retries are counted at claim time, not on failure.** A job that kills its
worker every time still exhausts its budget and lands in `dead` rather than
looping forever. A worker that dies leaves its jobs `claimed`; once the lease
lapses they return to `pending` and another worker — or the same one
restarting — picks them up. That is what makes "close the laptop, reopen it,
the campaign resumes" true rather than aspirational.

**A batch is submitted at most once.** The Anthropic batch id is written to the
campaign immediately after submission, so a worker that dies before recording
it finds the id on retry and goes straight to polling instead of submitting —
and paying for — a second batch.

**Nothing sends without human approval.** Generated emails land in `generated`
or `flagged`, never `approved`. The dispatcher reads exactly one status —
`approved` — so every other state is structurally unsendable rather than
merely discouraged.

Flags split into two kinds and the distinction is the whole design:
**errors** (empty body, literal `{{ }}`) block approval, because no human
judgement makes them sendable; **warnings** (an empty merge variable, a
possible invention, an em-dash you asked to avoid) never block, because
judging them in context is what the reviewer is for. Approving a mixed
selection approves what it can and reports precisely what it refused.

**Editing drops a row out of approved and recomputes its flags.** A decision
made about one wording cannot carry over to different wording, and fixing a
problem clears the warning that reported it.

**Two compliance profiles.** `one_to_one` sets `List-Unsubscribe` and
`List-Unsubscribe-Post` headers plus a soft opt-out line — no newsletter
footer on a personal email, so the machine-readable opt-out is invisible to
the reader while Gmail still shows its native unsubscribe control. `bulk` adds
the full CAN-SPAM footer with a visible link. Both carry a physical postal
address, because CAN-SPAM applies to any commercial email and 1:1 sales
outreach is commercial — the preflight **blocks** without one rather than
warning, and there is no override.

Both enforce the suppression list **at dispatch time**, so someone who
unsubscribes mid-campaign is still dropped.

**The unsubscribe GET does not unsubscribe.** Corporate mail scanners and
Gmail prefetch every link in a message, so a GET that changed state would
unsubscribe people who never clicked. GET renders a confirmation page; the
one-click POST (RFC 8058) is what the header points at. Tokens are HMAC-signed
and self-verifying, so a link keeps working even after the campaign row is
deleted, and there is no per-recipient lookup on a public endpoint.

**No open tracking.** Gmail provides none natively, and a tracking pixel on 1:1
outreach costs more in deliverability and trust than the data is worth. Reply
rate is the metric.

**Bounce detection is opt-in, and the trade-off is stated plainly.** Gmail
pushes no bounce notification — a failed delivery arrives as a message from
mailer-daemon in your own inbox — so detecting one means reading the mailbox
with `gmail.readonly`, which grants far more than sending does. Off by default,
behind a deliberate re-consent. Only a *confirmed hard* bounce suppresses an
address; a soft one is recorded but never acted on, because suppressing over a
full mailbox loses a real contact.

**A timed-out send is never retried blindly.** Gmail's API has no idempotency
parameter, so a request that fails mid-flight may or may not have delivered.
Those rows stay in `sending` and are surfaced for a person to check against
their Sent folder — a duplicate is worse than a gap. Only errors that
*definitely* mean non-delivery (429, 5xx, network) return a row to `approved`.

**Every header value is stripped of CR and LF.** A contact called
`Ana
Bcc: everyone@corp.com` would otherwise silently add a recipient.
There is no way to opt out of that sanitisation.

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
    ai/                    models · cost · prompt · guardrails
    review/flags.ts        flag severity, and what blocks approval
    gmail/                 scopes · RFC 2822 assembly · pacing
    compliance/footer.ts   the two profiles, and what blocks a send
    gmail/bounce.ts        RFC 3464 parsing, hard vs soft, rate limits
    gmail/scopes.ts
  db/
    schema.ts              13 tables
    index.ts               pooled runtime client (prepare: false)
    migrate.ts             direct-connection migrator
  lib/
    ai/client.ts           user's key, decrypted per call
    gmail/                 token refresh · users.messages.send · read
    compliance/            HMAC unsubscribe tokens
    queue/                 FOR UPDATE SKIP LOCKED, backoff, lease reclaim
    jobs/                  handlers · render-and-flag · dispatcher · inbox poll
    crypto.ts              AES-256-GCM + unsubscribe HMAC
    supabase/              browser · server · proxy clients
    auth/                  Google credential ownership
  worker/index.ts          the long-lived worker process
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
| 3 | ✅ | AI slots, BYO key, guardrails, live cost meter |
| 4 | ✅ | Job queue, worker, Batch API generation |
| 5 | ✅ | Review screen, flags, approval gate |
| 6 | ✅ | Gmail send, idempotency, throttle, quota |
| 7 | ✅ | Unsubscribe, suppression, preflight |
| 8 | ✅ | Bounce detection (opt-in), reporting |
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
