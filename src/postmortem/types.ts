// Post-mortem model. Mirrors migrations/0003_postmortems.sql. See ROADMAP.md.

export const POSTMORTEM_STATUSES = ["draft", "published"] as const;
export type PostmortemStatus = (typeof POSTMORTEM_STATUSES)[number];

export interface ActionItem {
  id: string;
  postmortem_id: string;
  description: string;
  owner: string | null;
  done: boolean;
  created_at: string;
}

export interface Postmortem {
  id: string;
  incident_id: string;
  status: PostmortemStatus;
  summary: string;
  impact: string;
  root_cause: string;
  contributing_factors: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface PostmortemWithItems extends Postmortem {
  action_items: ActionItem[];
}

/** The editable fields a human (or the auto-draft) can set. */
export interface PostmortemDraft {
  summary: string;
  impact: string;
  root_cause: string;
  contributing_factors: string;
  action_items: string[]; // descriptions
}
