-- Admin delete → a 30-day trash bin.
--
-- This is NOT the same thing as `removed`. `removed` is the do-not-call ban:
-- the number goes on the blocklist, the lead stays in the database and stays
-- visible to the manager under Manage → DNC, and future imports of that number
-- stay out. `deleted_at` means the lead is gone from the app entirely — it
-- disappears from every list, count, dedupe lookup and related-rows panel, and
-- its data is destroyed for real when the bin is emptied (by hand, or by the
-- 30-day sweep in server/trash.js).
ALTER TABLE leads
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by text;

-- the bin is a small slice of a big table, so the index carries only the slice
CREATE INDEX leads_deleted_idx ON leads (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- deleting a company takes its job postings with it, and one restore has to put
-- exactly that sweep back. now() is transaction-stable, so the company and its
-- jobs share one deleted_at value — that shared timestamp IS the batch id.
CREATE INDEX leads_deleted_company_idx ON leads (company_lead_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

-- the append-only log records the three trash actions like any other mutation
ALTER TABLE activity_log DROP CONSTRAINT activity_log_action_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_action_check
  CHECK (action IN ('open', 'status', 'owner', 'favorite', 'unfavorite', 'note',
                    'remove', 'restore', 'import', 'jobsearch',
                    'delete', 'undelete', 'purge'));

-- the admin grid's segment counts must not count what the app can't see
CREATE OR REPLACE VIEW segments AS
  SELECT category, state, count(*) AS companies
  FROM leads
  WHERE kind = 'company' AND NOT removed AND deleted_at IS NULL
        AND category IS NOT NULL AND state IS NOT NULL
  GROUP BY category, state;
