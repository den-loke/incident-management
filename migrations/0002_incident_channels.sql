-- Maps a Slack channel to the Durable Object id of its incident, so inbound
-- events in a channel can be routed to the right Incident DO. See src/router.ts.

CREATE TABLE IF NOT EXISTS incident_channels (
  channel     TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  do_id       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
