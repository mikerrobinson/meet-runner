-- Convert an `objects` table from team/meet columns to a single `scope`.
--
-- Written for the one upgrade that can't happen on its own: the table already
-- exists, so `CREATE TABLE IF NOT EXISTS` won't reshape it, and the first
-- write after deploying the new code fails on a missing column.
--
-- Everything is preserved. Athletes were already their own rows, so the only
-- real change to the data is that a meet learns to name its teams — the column
-- it used to be filed under becomes a field it carries.
--
-- Back up first:
--   npx wrangler d1 export meet-runner --remote --output backups/prod-$(date +%F).sql

CREATE TABLE IF NOT EXISTS objects_scoped (
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL,
  deleted_at INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (type, id)
);

INSERT OR REPLACE INTO objects_scoped
  (id, type, scope, updated_at, server_at, deleted_at, data)
SELECT
  id,
  type,
  CASE
    -- People belong to nobody now.
    WHEN type = 'athlete' THEN 'global'
    -- A team's own long-lived things.
    WHEN type IN ('team', 'season', 'enrollment') THEN 'team:' || team_id
    -- A meet and its lineup share the meet's id, on purpose.
    WHEN type IN ('meet', 'lineup') THEN 'meet:' || id
    -- Everything else inside a meet was already filed under it.
    ELSE 'meet:' || COALESCE(meet_id, '')
  END,
  updated_at,
  server_at,
  deleted_at,
  CASE
    -- The one field that has to be invented: the team a meet used to belong
    -- to becomes the first of the teams it references.
    WHEN type = 'meet' THEN json_set(data, '$.teamIds', json_array(team_id))
    ELSE data
  END
FROM objects;

DROP TABLE objects;
ALTER TABLE objects_scoped RENAME TO objects;
CREATE INDEX IF NOT EXISTS objects_cursor ON objects (scope, server_at);
