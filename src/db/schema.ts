import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Schema — Postgres via Supabase.
 *
 * Conventions:
 *  - Every table carries `userId`. Single-user today, but RLS policies key off
 *    it, so multi-tenancy later is a policy change, not a data migration.
 *  - Timestamps are `timestamptz`. The send scheduler does real timezone maths
 *    (recipient-local business-hour windows); a naive column would be a bug farm.
 *  - Secrets are stored as three columns (ciphertext / iv / tag) — AES-256-GCM.
 *    See src/lib/crypto.ts. No plaintext credential ever touches this schema.
 *  - `profiles.id` mirrors `auth.users.id`. The foreign key into Supabase's auth
 *    schema is added in a custom SQL migration rather than declared here, so
 *    drizzle-kit never tries to manage the `auth` schema it does not own.
 */

// ─── enums ───────────────────────────────────────────────────────────────────

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'generating',
  'reviewing',
  'scheduled',
  'sending',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

/** Per-recipient state machine. Transitions are recorded in `audit_log`. */
export const recipientStatusEnum = pgEnum('recipient_status', [
  'pending',
  'generating',
  'generated',
  'flagged',
  'approved',
  'rejected',
  'queued',
  'sending',
  'sent',
  'failed',
  'bounced',
  'complained',
])

/**
 * `one_to_one` — personal outreach: List-Unsubscribe headers plus a soft
 *   opt-out line, no newsletter chrome.
 * `bulk` — full CAN-SPAM footer with a visible unsubscribe link and postal address.
 */
export const complianceProfileEnum = pgEnum('compliance_profile', ['one_to_one', 'bulk'])

export const columnRoleEnum = pgEnum('column_role', ['email', 'merge_var', 'ai_context', 'ignore'])

export const suppressionReasonEnum = pgEnum('suppression_reason', [
  'unsubscribed',
  'hard_bounce',
  'complaint',
  'manual',
  'invalid',
])

export const jobStatusEnum = pgEnum('job_status', ['pending', 'claimed', 'done', 'failed', 'dead'])

export const consentBasisEnum = pgEnum('consent_basis', [
  'consent',
  'legitimate_interest',
  'contract',
  'unknown',
])

/** Why a CSV row was not imported. Mirrors `RowStatus` in core/csv, minus `valid`. */
export const contactRejectReasonEnum = pgEnum('contact_reject_reason', [
  'missing_email',
  'invalid_email',
  'duplicate',
  'suppressed',
])

// ─── identity ────────────────────────────────────────────────────────────────

export const profiles = pgTable('profiles', {
  /** Same UUID as auth.users.id. FK added in the custom RLS migration. */
  id: uuid().primaryKey(),
  email: text().notNull(),
  fullName: text(),
  avatarUrl: text(),

  /**
   * Physical postal address.
   *
   * CAN-SPAM requires a valid physical address in every commercial email, and
   * 1:1 sales outreach is commercial. The send preflight blocks without it —
   * this is a legal requirement, not a preference.
   */
  postalAddress: text(),

  /**
   * The soft opt-out sentence used by the 1:1 profile.
   *
   * A personal email gets a human sentence rather than a newsletter footer;
   * the machine-readable opt-out rides in the List-Unsubscribe headers.
   */
  optOutLine: text(),

  /** Display name on outgoing mail. Falls back to the Google account name. */
  senderName: text(),

  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * The Gmail sending credential.
 *
 * Supabase Auth performs the initial Google handshake, but it does not refresh
 * provider tokens and surfaces `provider_refresh_token` only on first consent.
 * So we capture it once and own its lifecycle from then on.
 */
export const googleAccounts = pgTable(
  'google_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    googleEmail: text().notNull(),

    refreshTokenCiphertext: text().notNull(),
    refreshTokenIv: text().notNull(),
    refreshTokenTag: text().notNull(),

    /** Cached access token, so we do not hit Google's token endpoint per send. */
    accessTokenCiphertext: text(),
    accessTokenIv: text(),
    accessTokenTag: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),

    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** 500/day for consumer Gmail, 2000/day for Workspace. Rolling 24h window. */
    dailyQuotaLimit: integer().notNull().default(500),

    /**
     * Opt-in inbox polling.
     *
     * Gmail has no bounce webhook — a failed delivery arrives as a message in
     * your own inbox. Detecting one therefore means reading the mailbox, which
     * needs `gmail.readonly`: a far broader permission than sending. It is off
     * by default and requires a deliberate re-consent.
     */
    inboxPollingEnabled: boolean().notNull().default(false),
    lastInboxPollAt: timestamp({ withTimezone: true }),

    /** Set when Google reports the grant was revoked; forces a re-consent. */
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('google_accounts_user_email_uq').on(t.userId, t.googleEmail),
    index('google_accounts_user_idx').on(t.userId),
  ],
)

/** Bring-your-own-key. Absent → the app runs in template-only mode. */
export const aiCredentials = pgTable(
  'ai_credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    provider: text().notNull().default('anthropic'),

    keyCiphertext: text().notNull(),
    keyIv: text().notNull(),
    keyTag: text().notNull(),
    /** Last 4 chars, so the UI can show `sk-ant-...4f2a` without decrypting. */
    keyLast4: text().notNull(),

    defaultModel: text().notNull().default('claude-haiku-4-5'),
    useBatchApi: boolean().notNull().default(true),
    usePromptCaching: boolean().notNull().default(true),
    lastValidatedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ai_credentials_user_provider_uq').on(t.userId, t.provider)],
)

/** Actual spend, read from each API response's `usage` — never estimated. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    campaignId: uuid(),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default('0'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_usage_user_created_idx').on(t.userId, t.createdAt),
    index('ai_usage_campaign_idx').on(t.campaignId),
  ],
)

// ─── contacts ────────────────────────────────────────────────────────────────

/** One CSV import. `columnMap` records the header-to-role decisions from step 2. */
export const contactLists = pgTable(
  'contact_lists',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    sourceFilename: text(),
    /**
     * Keyed by the spreadsheet's own header.
     *
     * `order` is the column's position in the file. It has to be stored
     * explicitly because jsonb does not preserve key order — it sorts by key
     * length, then bytewise — so without it "First Name" sorts after "Notes"
     * and the list reads nothing like the CSV it came from.
     */
    columnMap: jsonb()
      .$type<
        Record<
          string,
          {
            role: 'email' | 'merge_var' | 'ai_context' | 'ignore'
            variable?: string
            order?: number
          }
        >
      >()
      .notNull()
      .default({}),

    /**
     * One counter per outcome, so they sum to `rowCount` exactly.
     *
     * `invalidCount` is a malformed address only. A blank cell is a different
     * problem with a different fix, so it gets its own counter rather than
     * being folded in — the import wizard has always shown them apart, and the
     * list should not quietly disagree with it.
     */
    rowCount: integer().notNull().default(0),
    validCount: integer().notNull().default(0),
    duplicateCount: integer().notNull().default(0),
    invalidCount: integer().notNull().default(0),
    missingCount: integer().notNull().default(0),
    suppressedCount: integer().notNull().default(0),

    /** GDPR/CASL: recorded at import, because it cannot be reconstructed later. */
    consentBasis: consentBasisEnum().notNull().default('unknown'),
    consentSource: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contact_lists_user_idx').on(t.userId)],
)

export const contacts = pgTable(
  'contacts',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    listId: uuid()
      .notNull()
      .references(() => contactLists.id, { onDelete: 'cascade' }),

    /** Normalised (trimmed + lowercased) in core/csv. Never trust collation for dedupe. */
    email: text().notNull(),
    /** As it appeared in the CSV, for display. */
    emailRaw: text().notNull(),

    /** Every mapped column, so arbitrary CSV shapes need no migration. */
    data: jsonb().$type<Record<string, string>>().notNull().default({}),

    rowNumber: integer().notNull(),
    isValid: boolean().notNull().default(true),
    validationError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contacts_list_email_uq').on(t.listId, t.email),
    index('contacts_user_idx').on(t.userId),
    index('contacts_data_gin').using('gin', t.data),
  ],
)

/**
 * Rows that did not make it in, kept so "3 of 12 rows were not imported" can
 * be opened rather than merely believed.
 *
 * A separate table because `contacts` cannot hold them: its unique index on
 * (list_id, email) is the very thing that rejects a duplicate, and a row with
 * an empty email cell cannot satisfy a NOT NULL email. Forcing them in would
 * mean weakening the constraints that make the good data trustworthy.
 */
export const contactRejects = pgTable(
  'contact_rejects',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    listId: uuid()
      .notNull()
      .references(() => contactLists.id, { onDelete: 'cascade' }),

    /** Matches the line number in the user's spreadsheet, header included. */
    rowNumber: integer().notNull(),
    reason: contactRejectReasonEnum().notNull(),
    /** As it appeared in the file — unusable, which is the point. */
    emailRaw: text().notNull().default(''),
    /** The same sentence the import wizard showed, e.g. "No @ sign". */
    issue: text(),
    /** For `duplicate`: the earlier row that won. */
    duplicateOf: integer(),
    /** The mapped columns, so the row is recognisable in the spreadsheet. */
    data: jsonb().$type<Record<string, string>>().notNull().default({}),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A row number is unique within a list, which makes a retried chunk after
    // a dropped connection a no-op rather than a duplicate reject.
    uniqueIndex('contact_rejects_list_row_uq').on(t.listId, t.rowNumber),
    index('contact_rejects_list_idx').on(t.listId),
    index('contact_rejects_user_idx').on(t.userId),
  ],
)

// ─── templates & campaigns ───────────────────────────────────────────────────

export const templates = pgTable(
  'templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    subjectTpl: text().notNull().default(''),
    bodyTpl: text().notNull().default(''),

    /** Merge variables referenced by the template, extracted at save time. */
    variables: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * Slot-based AI config: model, per-slot briefs, tone, guardrails.
     * The model fills bounded `{{ai:name}}` slots — it never writes whole emails.
     */
    aiConfig: jsonb()
      .$type<{
        enabled: boolean
        model?: string
        tone?: string
        slots?: Record<string, { brief: string; maxSentences?: number }>
        guardrails?: string[]
      }>()
      .notNull()
      .default({ enabled: false }),

    complianceProfile: complianceProfileEnum().notNull().default('one_to_one'),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('templates_user_idx').on(t.userId)],
)

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    templateId: uuid().references(() => templates.id, { onDelete: 'set null' }),
    listId: uuid().references(() => contactLists.id, { onDelete: 'set null' }),
    googleAccountId: uuid().references(() => googleAccounts.id, { onDelete: 'set null' }),

    status: campaignStatusEnum().notNull().default('draft'),
    complianceProfile: complianceProfileEnum().notNull().default('one_to_one'),

    /** Hard stop. Generation aborts rather than overrunning the user's own key. */
    spendCapUsd: numeric({ precision: 10, scale: 2 }).notNull().default('5.00'),

    /** Deliberately well under Gmail's cap — protects account reputation. */
    ratePerHour: integer().notNull().default(40),
    sendWindowStartHour: integer().notNull().default(9),
    sendWindowEndHour: integer().notNull().default(17),
    sendWindowDays: integer()
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5}'::integer[]`),
    respectRecipientTimezone: boolean().notNull().default(false),
    threadFollowUps: boolean().notNull().default(true),

    /**
     * Anthropic Message Batch id for the generation run.
     *
     * Written immediately after the batch is submitted so a worker that dies
     * between submitting and recording cannot submit — and pay for — the same
     * batch twice. On retry, a set value means "skip submitting, go and poll".
     */
    generationBatchId: text(),

    scheduledAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_user_idx').on(t.userId), index('campaigns_status_idx').on(t.status)],
)

/** One row per recipient — the generated email plus its state machine. */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    status: recipientStatusEnum().notNull().default('pending'),

    subject: text(),
    bodyText: text(),
    bodyHtml: text(),
    /** Raw AI slot outputs, kept separate so a regenerate can replace one slot. */
    aiSlots: jsonb().$type<Record<string, string>>().notNull().default({}),

    /** Review flags: empty_output, unresolved_var, too_long, spam_words, hallucination. */
    flags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    editedByUser: boolean().notNull().default(false),

    gmailMessageId: text(),
    gmailThreadId: text(),

    /**
     * Unique. This is what makes a double-send structurally impossible:
     * a worker that dies mid-send cannot produce a second message.
     */
    idempotencyKey: text().notNull(),

    attempts: integer().notNull().default(0),
    error: text(),

    generatedAt: timestamp({ withTimezone: true }),
    approvedAt: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('campaign_recipients_idempotency_uq').on(t.idempotencyKey),
    uniqueIndex('campaign_recipients_campaign_contact_uq').on(t.campaignId, t.contactId),
    index('campaign_recipients_campaign_status_idx').on(t.campaignId, t.status),
    index('campaign_recipients_user_idx').on(t.userId),
  ],
)

// ─── compliance ──────────────────────────────────────────────────────────────

/**
 * Global suppression list, enforced at DISPATCH time rather than generation
 * time — so someone who unsubscribes mid-campaign is still dropped.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    reason: suppressionReasonEnum().notNull(),
    source: text(),
    campaignId: uuid().references(() => campaigns.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suppressions_user_email_uq').on(t.userId, t.email),
    index('suppressions_email_idx').on(t.email),
  ],
)

// ─── queue & audit ───────────────────────────────────────────────────────────

/**
 * Durable job queue in Postgres.
 *
 * Claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, which is a correct queue
 * primitive — no Redis, no extra service, and it survives the worker being
 * killed. Closing the laptop pauses a campaign; reopening resumes it exactly
 * where it stopped.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum().notNull().default('pending'),

    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    /** Exponential backoff target; the claim query filters on this. */
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),

    lockedBy: text(),
    lockedAt: timestamp({ withTimezone: true }),
    lastError: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('jobs_claim_idx').on(t.status, t.runAfter), index('jobs_user_idx').on(t.userId)],
)

/** Provider/webhook events and locally-detected bounces. */
export const events = pgTable(
  'events',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    recipientId: uuid().references(() => campaignRecipients.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    raw: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_recipient_idx').on(t.recipientId)],
)

/** Append-only. Every state transition lands here; nothing updates or deletes. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => profiles.id, { onDelete: 'set null' }),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    before: jsonb().$type<Record<string, unknown>>(),
    after: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId)],
)
