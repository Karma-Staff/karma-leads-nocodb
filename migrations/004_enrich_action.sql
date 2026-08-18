-- 004: the phone-backfill sweep (server/enrich.js --apply) logs ONE summary
-- row per run — like bulk actions, a per-lead row per fill would bury the
-- feed. New action name, so the closed CHECK list grows by one.
ALTER TABLE activity_log DROP CONSTRAINT activity_log_action_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_action_check
  CHECK (action IN ('open', 'status', 'owner', 'favorite', 'unfavorite', 'note',
                    'remove', 'restore', 'import', 'jobsearch',
                    'delete', 'undelete', 'purge', 'enrich'));
