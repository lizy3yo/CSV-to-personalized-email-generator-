CREATE TYPE "public"."contact_reject_reason" AS ENUM('missing_email', 'invalid_email', 'duplicate', 'suppressed');--> statement-breakpoint
CREATE TABLE "contact_rejects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"reason" "contact_reject_reason" NOT NULL,
	"email_raw" text DEFAULT '' NOT NULL,
	"issue" text,
	"duplicate_of" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_lists" ADD COLUMN "missing_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_lists" ADD COLUMN "suppressed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_rejects" ADD CONSTRAINT "contact_rejects_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_rejects" ADD CONSTRAINT "contact_rejects_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_rejects_list_row_uq" ON "contact_rejects" USING btree ("list_id","row_number");--> statement-breakpoint
CREATE INDEX "contact_rejects_list_idx" ON "contact_rejects" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "contact_rejects_user_idx" ON "contact_rejects" USING btree ("user_id");--> statement-breakpoint

-- ── RLS, matching every other owned table ──────────────────────────────────
-- Appended to this migration rather than added as a later one on purpose: a
-- table that exists without RLS, even for one migration, is the hole. Guarded
-- on auth.uid() so it still applies to plain Postgres in CI, exactly as
-- 0001_rls_and_auth does.
ALTER TABLE "contact_rejects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uid'
                 AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth')) THEN
    RAISE NOTICE 'auth.uid() not found - skipping contact_rejects policy (plain Postgres, e.g. CI).';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS contact_rejects_owner_policy ON contact_rejects;
  CREATE POLICY contact_rejects_owner_policy ON contact_rejects FOR ALL TO authenticated
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);
END $$;
