/// <reference types="@cloudflare/workers-types" />
// Post-mortem generation service. Loads an incident's timeline from D1, asks the
// summarizer for a structured draft, and persists it via PostmortemStore.
// Shared by the resolve auto-draft hook and the "regenerate" API route.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { Incident, IncidentUpdate } from "../status/types";
import { PostmortemStore } from "./store";
import type { PostmortemWithItems } from "./types";
import type { Summarizer, TimelineEntry } from "../clients/openai";
import { OpenAiSummarizer } from "../clients/openai";
import { FakeSummarizer } from "../clients/fakeOpenai";

// Test seam mirroring the DO's: tests register a fake summarizer here so the
// service never calls OpenAI. Bypass mode also uses a fake.
let summarizerOverride: ((env: Env) => Summarizer) | undefined;
export function __setPostmortemSummarizer(f: ((env: Env) => Summarizer) | undefined): void {
  summarizerOverride = f;
}

function buildSummarizer(env: Env): Summarizer {
  if (summarizerOverride) return summarizerOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSummarizer();
  return new OpenAiSummarizer(env.OPENAI_API_KEY);
}

/**
 * (Re)generate the post-mortem draft for an incident from its timeline.
 * Returns null if the incident does not exist. No-op overwrite if the
 * post-mortem is already published (PostmortemStore enforces this).
 */
export async function generatePostmortemDraft(
  env: Env,
  incidentId: string,
): Promise<PostmortemWithItems | null> {
  const db = new D1Db(env.DB);
  const incident = await db.get<Incident>(
    "SELECT * FROM incidents WHERE id = ?",
    [incidentId],
  );
  if (!incident) return null;

  const updates = await db.all<IncidentUpdate>(
    "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
    [incidentId],
  );
  const timeline: TimelineEntry[] = updates.map((u) => ({
    body: u.body,
    status: u.status,
    created_at: u.created_at,
  }));

  const fields = await buildSummarizer(env).draftPostmortem(
    incident.name,
    timeline,
  );

  const store = new PostmortemStore(db);
  return store.saveDraft(incidentId, {
    summary: fields.summary,
    impact: fields.impact,
    root_cause: fields.root_cause,
    contributing_factors: fields.contributing_factors,
    action_items: fields.action_items,
  });
}
