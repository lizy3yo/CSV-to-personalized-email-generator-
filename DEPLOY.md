# Deployment

The app runs perfectly well on your own machine, and for a single-user tool
that is often the right answer. This describes what changes if you want it
running somewhere else — and, first, whether you should.

---

## Should you deploy it at all?

| | Local | Hosted |
|---|---|---|
| Cost | £0 | £0–5/month |
| Contact data | never leaves your machine | on someone else's server |
| Sending | only while the machine is awake | unattended |
| Setup | done | an afternoon |

**The only real reason to host this is unattended sending.** A 1,240-email
campaign at Gmail's 500/day cap takes three days, and locally that means
leaving a laptop awake for three days.

Everything else — privacy, cost, simplicity — favours staying local. The queue
is durable, so closing the laptop pauses a campaign and reopening resumes it
exactly where it stopped, with no gaps and no double-sends.

---

## Option A — a small VPS (recommended if you host)

The closest thing to what you already run, and the only option where the worker
is a real long-lived process rather than something being poked on a timer.

Any £4/month box with 2 GB of RAM works.

```bash
# on the server
git clone <your repo> && cd csv-email-generator
npm ci
cp .env.example .env.local     # fill it in, as in SETUP.md
npm run db:start               # Supabase in Docker, same as locally
npm run db:migrate
npm run build
```

Then run two processes under a supervisor (systemd, pm2, Docker Compose):

```
npm run start     # the app
npm run worker    # generation and paced sending
```

Two changes from local:

1. **`NEXT_PUBLIC_SITE_URL`** must be your real URL — unsubscribe links are
   built from it, and a link pointing at `localhost` reaches nobody.
2. **Add the new callback** to Google's authorised redirect URIs. It is still
   Supabase's callback, now on your host:
   `https://<your-domain>/auth/v1/callback` if you expose Supabase, or keep
   `http://127.0.0.1:54321/auth/v1/callback` if you sign in via an SSH tunnel.

Put it behind a reverse proxy with TLS. Google will not accept a plain-HTTP
redirect URI on a public hostname.

---

## Option B — Vercel plus Supabase Cloud

Familiar, and the free tiers cover this. Two real constraints:

### The worker has nowhere to live

There is no long-running process on Vercel, so `campaign.dispatch` has to be
driven externally. `POST /api/cron/worker` exists for exactly this — it claims
a few jobs, runs them, and returns quickly.

| Driver | Interval | Notes |
|---|---|---|
| **Supabase `pg_cron` + `pg_net`** | 1 min | No extra service; both are available on the free tier |
| cron-job.org | 1 min | Free, external, simplest to set up |
| GitHub Actions schedule | 5 min | Free, but the coarsest interval |
| Vercel Cron | **1 day on Hobby** | Too coarse for sending. Pro allows minute-level |

Set `CRON_SECRET` and send it as `Authorization: Bearer <secret>`. The endpoint
**refuses to run at all** in production without it, rather than sitting there
as an open trigger.

Example, using Supabase's own scheduler:

```sql
select cron.schedule(
  'drain-worker-queue',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<your-app>.vercel.app/api/cron/worker',
    headers := '{"Authorization": "Bearer <your CRON_SECRET>"}'::jsonb
  );
  $$
);
```

Pacing still works — the dispatcher sends one email per run and reschedules
itself — but a campaign can only progress as often as something pokes it.

### Two connection strings, not one

Supabase Cloud gives a pooled connection and a direct one, and they are not
interchangeable:

```
DATABASE_URL   port 6543   Supavisor, transaction mode   → runtime queries
DIRECT_URL     port 5432   direct/session                → migrations only
```

`src/db/index.ts` sets `prepare: false` because transaction pooling cannot hold
prepared statements. DDL through the pooler fails intermittently, which is the
worst way for it to fail.

### Also

- **Vercel Hobby is non-commercial** per their terms. Fine for personal use;
  move to Pro or a VPS if this becomes a product.
- **Free Supabase projects pause after ~1 week idle** and need a manual
  restore. A paused database means a stalled campaign.

---

## Before any deployment

```bash
npm run check     # typecheck, lint, format, unit tests
npm run e2e       # end-to-end
npm run doctor    # environment
```

Then, in order:

1. **Set `NEXT_PUBLIC_SITE_URL`** to the real URL. Unsubscribe links depend on it.
2. **Add the production callback** to Google's authorised redirect URIs.
3. **Add the production URL** to `additional_redirect_urls` in
   `supabase/config.toml`, or to the Cloud dashboard's redirect allow-list.
4. **Set `CRON_SECRET`** if anything will drive the worker over HTTP.
5. **Back up `ENCRYPTION_KEY`.** Losing it means every stored credential —
   the Google refresh token and the Anthropic key — becomes undecryptable, and
   both must be reconnected by hand.
6. **Run `npm run db:migrate`** against the production database using
   `DIRECT_URL`.

---

## Going past 100 users

The Google consent screen is in **Testing** mode, which allows 100 test users
and needs no review. Beyond that, `gmail.send` being a restricted scope means a
formal OAuth verification — a security questionnaire, a demo video, and
possibly a third-party assessment.

If you get that far, the honest answer is that Gmail is the wrong transport.
Its 500–2,000/day cap is a per-mailbox limit, not a product. Swap the provider:
`src/lib/gmail/send.ts` is one adapter behind one interface, and the queue,
pacing, review gate and compliance layer above it do not care what delivers the
message.
