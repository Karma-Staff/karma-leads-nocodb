-- One-off cleanup, 2026-08-11: a restarted `node index.js` (the OLD NocoDB
-- server) auto-loaded the new .env, saw DATABASE_URL, and created its ~97
-- metadata tables inside the `karma` application database. Nothing of ours
-- was touched (NocoDB only ADDED tables); this drops exactly those additions.
--
-- Scope is strictly the nc_* / xc_* prefixes — every NocoDB table uses them
-- and none of the application tables (leads, blocklist, recents, activity_log,
-- app_users, organizations, import_jobs, lead_*, service_tokens) do.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
             AND (table_name LIKE 'nc\_%' OR table_name LIKE 'xc\_%')
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', t);
  END LOOP;
END $$;
