-- ═══════════════════════════════════════════════════════════════════════════
--  Row Level Security, and the link into Supabase's auth schema.
--
--  Why this is hand-written rather than declared in schema.ts:
--  drizzle-kit would try to manage the `auth` schema, which belongs to
--  Supabase. Keeping the foreign key and the policies here means Drizzle stays
--  the single migration authority without reaching into territory it does not own.
--
--  Everything auth-dependent is guarded on the `auth` schema existing, so this
--  migration also applies cleanly to a plain Postgres instance in CI.
--
--  RLS is enabled unconditionally. It is close to pointless for a single user,
--  but it is ~40 lines now versus a security review later, and it means
--  multi-tenancy is a policy change rather than a data migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Enable RLS on every table ───────────────────────────────────────────
ALTER TABLE "profiles"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_accounts"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_credentials"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_lists"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "templates"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaigns"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_recipients"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppressions"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log"            ENABLE ROW LEVEL SECURITY;

-- ── 2. Link profiles to auth.users, and auto-create on signup ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth') THEN

    -- profiles.id IS auth.users.id. Deleting the auth user erases everything
    -- they own, which is what GDPR right-to-erasure requires.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_auth_users_fk'
    ) THEN
      ALTER TABLE "profiles"
        ADD CONSTRAINT "profiles_id_auth_users_fk"
        FOREIGN KEY ("id") REFERENCES auth.users("id") ON DELETE CASCADE;
    END IF;

    -- A trigger rather than application code: it guarantees a profile row
    -- exists for every auth user, including ones created outside this app
    -- (Supabase Studio, CLI, an admin invite).
    CREATE OR REPLACE FUNCTION public.handle_new_user()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $fn$
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, avatar_url)
      VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data ->> 'full_name',
        NEW.raw_user_meta_data ->> 'avatar_url'
      )
      ON CONFLICT (id) DO UPDATE
        SET email      = EXCLUDED.email,
            full_name  = COALESCE(EXCLUDED.full_name,  public.profiles.full_name),
            avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url),
            updated_at = now();
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT OR UPDATE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

  END IF;
END $$;

-- ── 3. Policies ────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  -- Every table below carries a `user_id` column, so one policy shape covers
  -- all of them. profiles and audit_log are special-cased afterwards.
  owned_tables text[] := ARRAY[
    'google_accounts', 'ai_credentials', 'ai_usage', 'contact_lists',
    'contacts', 'templates', 'campaigns', 'campaign_recipients',
    'suppressions', 'jobs', 'events'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uid'
                 AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth')) THEN
    RAISE NOTICE 'auth.uid() not found — skipping RLS policies (plain Postgres, e.g. CI).';
    RETURN;
  END IF;

  FOREACH t IN ARRAY owned_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner_policy', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO authenticated
         USING ((SELECT auth.uid()) = user_id)
         WITH CHECK ((SELECT auth.uid()) = user_id)',
      t || '_owner_policy', t
    );
  END LOOP;

  -- profiles keys on `id`, not `user_id`.
  DROP POLICY IF EXISTS profiles_owner_policy ON profiles;
  CREATE POLICY profiles_owner_policy ON profiles FOR ALL TO authenticated
    USING ((SELECT auth.uid()) = id)
    WITH CHECK ((SELECT auth.uid()) = id);

  -- audit_log is append-only: readable and insertable by its owner, never
  -- updatable or deletable. An audit trail that can be edited is not one.
  DROP POLICY IF EXISTS audit_log_read_policy   ON audit_log;
  DROP POLICY IF EXISTS audit_log_insert_policy ON audit_log;

  CREATE POLICY audit_log_read_policy ON audit_log FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

  CREATE POLICY audit_log_insert_policy ON audit_log FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = user_id);
END $$;
