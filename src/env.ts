import { z } from 'zod'

/**
 * Environment validation.
 *
 * Fails loudly and early with a readable message rather than surfacing as
 * `undefined` three layers deep at runtime.
 *
 * `SKIP_ENV_VALIDATION=1` exists for CI, where `next build` must succeed
 * without production secrets. It is never set in dev or production.
 */

const base64Key = (bytes: number, label: string) =>
  z
    .string()
    .min(1, `${label} is required — generate one with \`npm run keygen\``)
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === bytes
      } catch {
        return false
      }
    }, `${label} must be ${bytes} random bytes, base64-encoded (\`npm run keygen\`)`)

/**
 * `z.url()` is not used here: a Postgres DSN is a URL but the useful check is
 * the scheme, and a clear message beats a generic "invalid url".
 */
const postgresUrl = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      `${label} must start with postgres:// or postgresql://`,
    )

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: postgresUrl('DATABASE_URL'),
  DIRECT_URL: postgresUrl('DIRECT_URL'),

  ENCRYPTION_KEY: base64Key(32, 'ENCRYPTION_KEY'),
  UNSUBSCRIBE_SECRET: base64Key(32, 'UNSUBSCRIBE_SECRET'),

  // Optional until phase 6 (Gmail send). The app builds and runs without them.
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
})

const clientSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: z.url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
})

const skip = process.env.SKIP_ENV_VALIDATION === '1'

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown, scope: string): z.infer<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    if (skip) return {} as z.infer<T>
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(
      `\nInvalid ${scope} environment variables:\n${issues}\n\n` +
        `Copy .env.example to .env.local and fill it in.\n`,
    )
  }
  return result.data
}

/**
 * NEXT_PUBLIC_* values are referenced as static literals so the Next.js
 * compiler can inline them into the client bundle. Dynamic lookup
 * (`process.env[name]`) silently yields undefined in the browser.
 */
export const clientEnv = parse(
  clientSchema,
  {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
  'client',
)

let cachedServerEnv: z.infer<typeof serverSchema> | null = null

/**
 * Server-only. Lazily validated so importing a module that transitively
 * touches this file from a client component does not blow up the build.
 */
export function serverEnv(): z.infer<typeof serverSchema> {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv() was called in the browser. Server secrets must never reach the client.',
    )
  }
  cachedServerEnv ??= parse(serverSchema, process.env, 'server')
  return cachedServerEnv
}
