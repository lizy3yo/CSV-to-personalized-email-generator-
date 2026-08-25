import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import Papa from 'papaparse'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/db/schema'
import { contactLists, contacts, profiles, suppressions } from '@/db/schema'
import { detectColumns } from '@/core/csv/detect'
import { importableRows, ingest } from '@/core/csv/ingest'
import type { ColumnMap, RawRow } from '@/core/csv/types'

/**
 * Integration test against the real local database.
 *
 * The unit tests prove the pipeline classifies rows correctly. This proves the
 * database actually enforces what the design depends on:
 *   • the (list_id, email) unique index really does block duplicates
 *   • deleting a list really does cascade to its contacts
 *   • the auth.users trigger really does create a profile
 *
 * Those are constraints, not code — asserting them in TypeScript would prove
 * nothing. Skipped automatically when no database is reachable, so CI jobs
 * without one still pass.
 */

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL

async function probe(): Promise<boolean> {
  if (!url) return false
  const client = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    await client`select 1`
    return true
  } catch {
    return false
  } finally {
    await client.end({ timeout: 1 })
  }
}

const dbAvailable = await probe()

if (!dbAvailable) {
  console.warn('  [integration] no database reachable — skipping. Run `npm run db:start`.')
}

describe.skipIf(!dbAvailable)('contacts persistence', () => {
  const client = postgres(url!, { max: 2, onnotice: () => {} })
  const db = drizzle(client, { schema, casing: 'snake_case' })

  // A synthetic profile, inserted directly. The auth.users trigger is covered
  // separately below; this keeps the persistence tests independent of GoTrue.
  const userId = randomUUID()
  const email = `test-${userId.slice(0, 8)}@example.test`
  let listId: string

  beforeAll(async () => {
    // profiles.id has a foreign key to auth.users, so the auth row comes first.
    await client`
      INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      VALUES (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${email}, ${JSON.stringify({ full_name: 'Test User' })}::jsonb, now(), now())
      ON CONFLICT (id) DO NOTHING
    `
  })

  afterAll(async () => {
    // Cascades through profiles and everything below it.
    await client`DELETE FROM auth.users WHERE id = ${userId}`
    await client.end()
  })

  it('creates a profile automatically when an auth user appears', async () => {
    // The handle_new_user trigger guarantees a profile exists for every auth
    // user, including ones created outside this app (Studio, CLI, an invite).
    const profile = await db.query.profiles.findFirst({ where: eq(profiles.id, userId) })
    expect(profile).toBeDefined()
    expect(profile?.email).toBe(email)
    expect(profile?.fullName).toBe('Test User')
  })

  it('imports a real CSV end to end', async () => {
    const text = readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'messy.csv'), 'utf8')
    const { data, meta } = Papa.parse<RawRow>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    })
    const headers = (meta.fields ?? []).filter(Boolean)

    const columnMap: ColumnMap = {}
    for (const column of detectColumns(headers, data)) {
      columnMap[column.header] = { role: column.role, variable: column.variable }
    }

    await db.insert(suppressions).values({
      userId,
      email: 'blocked@example.com',
      reason: 'unsubscribed',
      source: 'test',
    })

    const suppressedRows = await db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(eq(suppressions.userId, userId))

    const result = ingest({
      rows: data,
      columnMap,
      suppressed: new Set(suppressedRows.map((r) => r.email)),
    })

    const [list] = await db
      .insert(contactLists)
      .values({
        userId,
        name: 'Fixture import',
        sourceFilename: 'messy.csv',
        columnMap,
        consentBasis: 'legitimate_interest',
      })
      .returning({ id: contactLists.id })
    listId = list.id

    const rows = importableRows(result).map((row) => ({
      userId,
      listId,
      email: row.email,
      emailRaw: row.emailRaw,
      data: row.data,
      rowNumber: row.rowNumber,
    }))

    const inserted = await db.insert(contacts).values(rows).returning({ id: contacts.id })
    expect(inserted).toHaveLength(2)

    const stored = await db
      .select()
      .from(contacts)
      .where(eq(contacts.listId, listId))
      .orderBy(contacts.rowNumber)

    expect(stored.map((c) => c.email)).toEqual(['a.chen@northwind.io', 'b.park@cascade.dev'])
    // The suppressed address never reached the table.
    expect(stored.map((c) => c.email)).not.toContain('blocked@example.com')
  })

  it('round-trips JSONB data including quoted commas and newlines', async () => {
    const [ana] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.listId, listId), eq(contacts.email, 'a.chen@northwind.io')))

    expect(ana.data.company).toBe('Northwind Traders, Inc.')
    expect(ana.emailRaw).toBe('a.chen@northwind.io')

    const [bo] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.listId, listId), eq(contacts.email, 'b.park@cascade.dev')))

    expect(bo.data.notes).toBe('Trialled last quarter.\nWent quiet after the pilot.')
    expect(bo.emailRaw).toBe('B.PARK@Cascade.dev')
  })

  it('blocks a duplicate address in the same list at the database level', async () => {
    // This is the constraint the retry-safety of chunked import depends on.
    await expect(
      db.insert(contacts).values({
        userId,
        listId,
        email: 'a.chen@northwind.io',
        emailRaw: 'a.chen@northwind.io',
        data: {},
        rowNumber: 999,
      }),
    ).rejects.toThrow()
  })

  it('makes a retried chunk a no-op rather than a duplicate', async () => {
    // A worker that dies mid-import and retries must not double-insert.
    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.listId, listId))

    const result = await db
      .insert(contacts)
      .values({
        userId,
        listId,
        email: 'a.chen@northwind.io',
        emailRaw: 'a.chen@northwind.io',
        data: {},
        rowNumber: 2,
      })
      .onConflictDoNothing({ target: [contacts.listId, contacts.email] })
      .returning({ id: contacts.id })

    const after = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.listId, listId))

    expect(result).toHaveLength(0)
    expect(after[0].count).toBe(before[0].count)
  })

  it('allows the same address in a different list', async () => {
    // Dedupe is per-list: the same person can legitimately be on two lists.
    const [other] = await db
      .insert(contactLists)
      .values({ userId, name: 'Second list', consentBasis: 'consent' })
      .returning({ id: contactLists.id })

    const inserted = await db
      .insert(contacts)
      .values({
        userId,
        listId: other.id,
        email: 'a.chen@northwind.io',
        emailRaw: 'a.chen@northwind.io',
        data: {},
        rowNumber: 2,
      })
      .returning({ id: contacts.id })

    expect(inserted).toHaveLength(1)
    await db.delete(contactLists).where(eq(contactLists.id, other.id))
  })

  it('cascades deletes from list to contacts', async () => {
    await db.delete(contactLists).where(eq(contactLists.id, listId))

    const remaining = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.listId, listId))

    expect(remaining[0].count).toBe(0)
  })
})
