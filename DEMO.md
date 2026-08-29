# Guided tour & demo script

- **Part 1** — what every item in the sidebar is for, then a walkthrough that
  uses them one at a time, in order.
- **Part 2** — a two-minute script for showing the app to someone else.

Sample data is in [`examples/demo-contacts.csv`](examples/demo-contacts.csv) —
12 rows, deliberately a bit messy.

To start: `npm run db:start`, then `npm run dev`, then
http://localhost:3000. (Full setup is in [SETUP.md](SETUP.md).)

---

## Part 1 — The tour

### The sidebar, at a glance

In the order they appear. What each is **for**, what you **do**, and **why** it
works that way.

| | What it's for | What you do | Why it works this way |
| --- | --- | --- | --- |
| **Campaigns** | Where you pick a list and a template, and the app makes the emails. | Press Generate. | It's only a list plus a template, so both stay reusable. |
| **Contacts** | Where your people live, after you drop in a spreadsheet. | Import a CSV. | Kept apart from campaigns, so you don't re-import the same spreadsheet every time. |
| **Templates** | Where you write the one email, leaving blanks for names. | Write it once. | Kept apart too, so you can fix your wording without rebuilding anything. |
| **Suppressions** | The list of people who must never get an email from you again. | Nothing — it fills itself. | A separate list, because the same person can sit in five spreadsheets. |
| **AI** | Where you paste your key, so the app writes one line per person. | Paste it once. | Your own key, so you pay your own bill and there's nothing shared to leak. |
| **Compliance** | Where you put your address, which every email must carry by law. | Type it once. | It blocks instead of warning, because a warning is easy to click past. |

**Review**, **Send** and **Report** are not in the sidebar — they live inside a
campaign, because they only exist once you have one.

> The sidebar order is not the order you use them in. Below is the real order.

---

### Step 1 — Contacts

**What it's for.** This is where your people live. You never type anyone in by
hand — you import a spreadsheet and it becomes a **list**. You can have as many
lists as you like (`Demo list`, `Trade show 2026`, whatever).

**This is where everything starts**, so it's the first thing we use.

**Use it now:**

1. **Contacts → Import**
2. Drop in `examples/demo-contacts.csv`

You don't configure anything. The app reads the file and works out what each
column is for:

| Column | Decided as | What that means |
| --- | --- | --- |
| Email Address | **Email** | where the message goes |
| First Name, Last Name, Company, City, Role | **Merge variable** | short values that get pasted into the email |
| Notes | **AI context** | too long to paste — the AI reads it for background |
| Internal ID | **Ignore** | no use in an email |

**What you should see:**

```
9 ready  ·  1 duplicate  ·  1 invalid address  ·  1 missing address
```

Click **View 3 issues** — it names the rows and the reason. One person was
exported twice, one address has `(at)` instead of `@`, one cell is blank.

Name the list `Demo list`, pick a lawful basis, then **Import 9**.

The three bad rows are never imported. That's the first checkpoint: a
spreadsheet mistake cannot become an email mistake.

**Now click the list.** The card is a link, and the tabs across the top open
each group: the 9 who made it, and the 3 who didn't with the reason and the row
number attached — `12 · k.becker(at)fjordline.no · No @ sign`. The count is not
something you have to take on trust.

---

### Step 2 — Templates

**What it's for.** The one email you write. Instead of a name you leave a
**blank**, and the app fills it per person. You write this once, not nine
times.

**Use it now: Templates → New.** Name it `Demo outreach`.

**Subject:**

```
Quick question{{#if company}} about {{ company | title }}{{/if}}
```

**Body:**

```
Hi {{ first_name | default: there }},

{{#if company}}I came across {{ company | title }} and wanted to write to you directly rather than send something generic.{{else}}I wanted to write to you directly rather than send something generic.{{/if}}

We help teams get personal email out the door without the copy-paste: one template, every detail filled in per person, and nothing leaves until a human has read it.

Would fifteen minutes next week be useful?

Best,
Kharl
```

Three kinds of blank, and that's the whole language:

| You write | It means |
| --- | --- |
| `{{ first_name }}` | paste their first name here |
| `{{ first_name \| default: there }}` | …but if it's empty, write `there` |
| `{{#if company}}…{{/if}}` | only include this bit if they have a company |

**Now the good part.** Pick `Demo list` in the preview panel and click through
people with the arrows. Watch three rows:

| Person | What you see | Why it matters |
| --- | --- | --- |
| **Dami Okafor** | `MERIDIAN LOGISTICS` comes out as `Meridian Logistics` | shouty spreadsheet data, fixed |
| **Lumen Studio** (no first name) | `Hi there,` — not `Hi ,` | the gap is filled, not left gaping |
| **Ines Moreau** (no company) | subject is just `Quick question`, and the sentence quietly drops its company clause | no empty brackets, no dangling comma |

Save it.

---

### Step 3 — Compliance

**What it's for.** Your postal address and how you sign off. Boring, and it
takes thirty seconds — but **sending is blocked until it's filled in**, so do
it now rather than hitting a wall later.

The law requires a real postal address in every commercial email, including
one-to-one sales outreach. The app enforces it rather than trusting you to
remember.

**Use it now: Compliance →** fill in **Physical postal address**:

```
Kharl De Jesus
123 Example Street
Manila 1000
Philippines
```

The address isn't stamped into the email now — it's added at the moment of
sending, so if you fix a typo later it applies to everything still unsent.

---

### Step 4 — Campaigns

**What it's for.** A campaign is just **a list + a template**, joined together.
That's all it is. Once you join them, it builds one finished email per person
and keeps track of where each one has got to.

**Use it now: Campaigns → New.** Pick `Demo list` and `Demo outreach`, call it
`Demo run`, create it.

Now press **Generate**.

Behind the scenes, for each of the nine people: the blanks get filled with
their data, and the result gets checked for anything broken — an empty subject,
a name that came out wrong.

If nothing moves, the queue has no worker. Open a second terminal:

```bash
npm run worker
```

---

### Step 5 — Review *(inside the campaign)*

**What it's for.** Nine finished emails, one per person, sitting still.
**Not one of them can send until you approve it.**

This is the most important screen in the app. It isn't a setting you could
switch off — the sending code only ever looks at emails marked `approved`.

**Use it now:**

- Click a row to open it — the real subject and body for that person
- Press **Edit** on one and change a sentence. It gets marked as edited, and
  your wording is what goes out
- Use the filter chips — **Flagged** shows anything the app thinks looks wrong
- Press **Approve**

Anything with a real error can't be approved at all. Warnings you can overrule;
errors you can't.

---

### Step 6 — Send *(inside the campaign)*

**What it's for.** The last gate. Before anything leaves it runs a preflight of
nine checks and refuses to start if any of them fail — Gmail connected, send
permission actually granted, daily limit has room, something is approved, the
unsubscribe link works, your postal address is set.

Then it sends **slowly**, one at a time with gaps, the way a person would — so
Gmail doesn't treat you as a spammer.

**Before you test this**, open `examples/demo-contacts.csv` and change two or
three addresses to your own. Gmail treats `you+ana@gmail.com` as you, so the
mail lands in your inbox and no stranger is touched. Re-import, then send.

If `npm run doctor` says `✗ Gmail send permission`, add
`https://www.googleapis.com/auth/gmail.send` under **Data Access** at
https://console.cloud.google.com/auth/scopes, then sign out and back in.

The **Report** screen fills in as it goes: sent, failed, bounced, unsubscribed.

---

### Step 7 — AI *(optional)*

**What it's for.** Your Anthropic key, and which model to use. The app ships
without a key — you bring your own, it's encrypted before it's stored, and it's
never sent back to the browser.

Everything above works fine forever without this. The AI is an upgrade, not a
requirement.

**Use it now:** get a key at https://console.anthropic.com, paste it into
**AI**, then go back to your template and add a slot on the second line:

```
Hi {{ first_name | default: there }},

{{ai:opener}}
```

Brief:

```
In one sentence, mention something specific from their notes. No flattery, no superlatives.
```

Regenerate the campaign. Now each person gets a different opening line, written
from their **Notes** column — Bo Park's mentions the API rate limits that
blocked him, Hana Novak's mentions the pricing PDF she downloaded twice and
never followed up on.

Note what it is *not* doing: it isn't writing your email. You wrote the email.
It writes one sentence, from real information, with a sentence limit and rules
you set. The cost of a run is shown before you commit to it.

---

### Step 8 — Suppressions

**What it's for.** The block list. Anyone here can never be emailed again, by
any campaign, ever.

**You will barely touch this screen** — it fills itself. Someone clicks
unsubscribe, or a message hard-bounces, and they land here automatically.

You can add someone by hand if they ask you by phone or in person.

The list is checked twice: once when you import a spreadsheet, and again at the
moment of sending — so if someone unsubscribes in the hour between generating
and sending, they still don't get the email.

---

### That's the whole loop

```
Contacts  →  Templates  →  Campaigns  →  Review  →  Send
   ↑                                                  │
   └────────  Suppressions  ←──  bounces & unsubscribes
```

Set up **Compliance** and **AI** once. Everything else repeats.

---

## Part 2 — The two-minute demo

Set up before you start: the CSV ready to drag, the app open on **Contacts →
Import**, a template already written, and a campaign already generated in
another tab — so you never wait for a spinner in front of an audience.

### 0:00 — The problem *(15 seconds)*

> "Say I've got a list of 200 people and I want to email all of them.
>
> Mail merge gets me 'Hi FirstName' — everyone can tell. Writing 200 real
> emails by hand takes a week.
>
> This does the thing in the middle."

### 0:15 — Contacts *(25 seconds)*

*Drag the CSV in.*

> "That's a normal messy export. I haven't told it anything about the file.
>
> It worked out which column is the email address, which bits go into the
> email, and that Notes is background — too long to paste in, but useful.
>
> And it caught three bad rows before they became a problem: one person
> exported twice, one typo, one blank."

*Click **View 3 issues**.*

> "It tells you which rows and why. Import the good nine."

### 0:40 — Templates *(25 seconds)*

*Open the template, click through preview rows with the arrows.*

> "I write this once.
>
> This company was in capitals in the spreadsheet — it comes out normal.
>
> This person's first name was missing — instead of 'Hi comma', it says 'Hi
> there'.
>
> And this one has no company at all, so that whole phrase just disappears. No
> awkward gap, no empty brackets."

### 1:05 — The AI part *(25 seconds)*

*Switch to the generated campaign, scroll through two or three emails.*

> "Now the AI bit. This one line is written per person, from their notes.
>
> His mentions the rate limits that blocked him. Hers mentions that she
> downloaded pricing twice and never booked.
>
> I'm not asking it to write the email — I wrote the email. It writes one
> sentence, off real information. That's the difference between personal and
> creepy."

*No API key? Skip this and give the time to Review instead.*

### 1:30 — Review *(20 seconds)*

*Point at the Review screen.*

> "This is the part I care about most.
>
> Nine finished emails. Not one of them can send until I've read it and pressed
> approve. I can edit any of them by hand, and my version is what goes out.
>
> Anything odd gets flagged — a broken link, a name that looks wrong, an empty
> line. The app will not let me approve those."

### 1:50 — Send *(10 seconds)*

*Open Send, point at the preflight list.*

> "Before anything leaves, it checks nine things: Gmail is connected, the daily
> limit has room, the unsubscribe link works, my postal address is there
> because that's the law.
>
> Then it sends slowly, the way a person would, so Gmail doesn't flag it.
> Anyone who unsubscribes or bounces is blocked from every future send,
> automatically.
>
> That's it."

---

### The one line, if you only get one

> "You write one email. It writes 200 versions from your spreadsheet. You read
> them before any of them leave."

### If someone asks

**"Isn't this spam?"** — No. It sends from your own Gmail, at your own daily
limit, one at a time, to people you already have a reason to contact. Every
message carries a working unsubscribe link and a real postal address, and
anyone who opts out or bounces goes onto a block list you cannot accidentally
override.

**"Does the AI write the whole email?"** — No, and that's deliberate. You write
the email. The AI fills specific slots you place in it, with a sentence limit
and rules like "no superlatives". It reads only the columns you marked as
context.

**"Where is my data?"** — On your machine. Local Postgres, local app. Your API
key and your Google token are encrypted in the database and are never sent back
to the browser.

**"What does it cost?"** — Gmail is free, at 500 emails a day for a personal
account. The AI is bring-your-own-key: on the default model it's cents per
hundred emails, and the exact figure is shown before you run it.
