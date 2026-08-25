# Setup

From a clean clone to a running app. Roughly 15 minutes, most of it waiting on
Docker to pull images.

---

## Prerequisites

| | Why |
|---|---|
| **Node 20.9+** (24 recommended) | Next.js 16 minimum |
| **Docker Desktop** running | `supabase start` runs Postgres, Auth, Studio and a mail catcher in containers |
| **A Google account** | Sign-in and sending both go through it |

Nothing else. No Neon account, no Vercel account, no paid service.

---

## 1. Install

```bash
npm install
```

## 2. Start the database

```bash
npm run db:start
```

First run pulls several images — expect a few minutes. When it finishes it
prints a block of URLs and keys. Keep it on screen; you need two values from it.

| Service | URL |
|---|---|
| Studio (browse tables) | http://localhost:54323 |
| API | http://127.0.0.1:54321 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Inbucket (catches test email) | http://localhost:54324 |

## 3. Configure environment

```bash
cp .env.example .env.local
```

Then fill in:

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from the
  `npm run db:start` output above.
- `ENCRYPTION_KEY` and `UNSUBSCRIBE_SECRET` — run `npm run keygen` once for
  each. They must be different values.

Leave the Google variables blank for now if you just want to see the app build
and the database come up.

> `ENCRYPTION_KEY` encrypts the Google refresh token and the Anthropic API key
> at rest. Changing it later invalidates every stored credential — you would
> have to reconnect Gmail and re-paste the AI key. Back it up.

## 4. Apply migrations

```bash
npm run db:migrate
```

Open http://localhost:54323 and you should see 13 tables under `public`.

## 5. Google OAuth

This is the fiddliest step. It is a one-time setup.

**5.1 — Create a project**
[console.cloud.google.com](https://console.cloud.google.com) → new project.

**5.2 — Enable the Gmail API**
APIs & Services → Library → search "Gmail API" → Enable.

**5.3 — Configure the consent screen**
APIs & Services → OAuth consent screen.

- User type: **External**
- Fill in app name, your email for support and developer contact
- Add the scope `https://www.googleapis.com/auth/gmail.send`
- **Leave publishing status as "Testing"** and add your own Google account
  under **Test users**

> Staying in Testing mode is deliberate. `gmail.send` is a restricted scope, so
> a *published* app would need Google's OAuth verification review. Testing mode
> allows up to 100 test users with no review at all — which is exactly right for
> a single-user tool. *(Google reshuffles scope tiers occasionally; if the
> console asks for verification, re-check the current classification in
> Google's OAuth docs.)*

**5.4 — Create credentials**
APIs & Services → Credentials → Create credentials → **OAuth client ID** →
Application type **Web application**.

Under **Authorized redirect URIs** add:

```
http://127.0.0.1:54321/auth/v1/callback
```

The redirect goes to *Supabase*, not to the Next.js app — Supabase handles the
handshake and then forwards to `/auth/callback`. When you later deploy to
Supabase Cloud, add `https://<project-ref>.supabase.co/auth/v1/callback` too.

Copy the client ID and secret into `.env.local`.

**5.5 — Tell Supabase about it**

Open `supabase/config.toml` and set:

```toml
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_CLIENT_ID)"
secret = "env(GOOGLE_CLIENT_SECRET)"
```

Then restart so it picks up the change:

```bash
npm run db:stop && npm run db:start
```

## 6. Run

```bash
npm run dev
```

http://localhost:3000 → you should be redirected to `/login`.

---

## Anthropic API key (optional)

Not needed to run the app. Phases 0–2 never call it, and **template-only mode
is fully functional forever without one** — merge variables, conditionals,
preview, review and send all work.

When you do want AI personalization, get a key at
[console.anthropic.com](https://console.anthropic.com) and paste it into
Settings → AI. It is encrypted before it is stored and never returned to the
browser afterwards.

Rough cost with Claude Haiku 4.5, prompt caching and the Batch API:
**about $1 per 1,000 emails.** $5 of credit covers roughly 5,000.

---

## Everyday commands

```bash
npm run dev            # app on :3000
npm run db:start       # Supabase containers
npm run db:stop        # stop them
npm run db:migrate     # apply pending migrations
npm run db:generate    # generate a migration after editing src/db/schema.ts
npm run check          # typecheck + lint + format + test — run before committing
npm run keygen         # print a new 32-byte base64 secret
```

---

## Troubleshooting

**`supabase start` fails** — Docker Desktop is not running, or ports
54321–54324 are taken. `docker ps` to check.

**`supabase start` fails with `no such host` during "Initialising schema"** —
Supabase derives container hostnames from `project_id` in
`supabase/config.toml`, which defaults to the directory name. This repository's
folder is `CSV-to-personalized-email-generator-`, which has capitals and a
**trailing hyphen** — an illegal hostname under RFC 1123, so Docker's internal
DNS cannot resolve it and the auth service fails to connect to Postgres.

`project_id` is already pinned to `csv-email-generator` for this reason. If you
rename it, keep it lowercase with no leading or trailing hyphen. (The same
folder name is why `create-next-app` had to be run elsewhere and moved in —
npm rejects capitals in a package name.)

**"Invalid server environment variables"** — `.env.local` is missing or a key
is not valid base64 of exactly 32 bytes. Regenerate with `npm run keygen`.

**Signed in but "Gmail connected" stays unchecked** — Google only issues a
refresh token on a fresh grant. Sign out, then sign in again; the app always
requests `prompt=consent`, which forces one. If it persists, revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
and sign in once more.

**`prepared statement already exists`** — `DATABASE_URL` points at a
transaction pooler while `prepare` is on. `src/db/index.ts` sets
`prepare: false`; check nothing else opens its own connection.

**Migrations fail on Supabase Cloud** — `DIRECT_URL` must be the direct
connection on port 5432, not the pooled one on 6543. DDL through a transaction
pooler fails intermittently.
