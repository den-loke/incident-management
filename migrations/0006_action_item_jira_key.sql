-- Jira action-item export. See ROADMAP.md.
-- When a post-mortem is published, each action item is exported to a Jira issue
-- (create + link back). We store the returned issue key here so we don't create
-- duplicates on re-publish and can render/link the ticket.

ALTER TABLE postmortem_action_items ADD COLUMN jira_key TEXT;
