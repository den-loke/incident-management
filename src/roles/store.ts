import type { Db } from "../status/sink";
import type { IncidentRole, RoleAssignment } from "./types";

/**
 * Incident role persistence over the Db port. Claiming a role is an upsert on
 * (incident_id, role), so a role always has at most one holder and claiming
 * transfers it. Unit-testable against real test D1.
 */
export class RoleStore {
  constructor(private readonly db: Db) {}

  /** Claim (or transfer) a role to a Slack user. Returns the assignment. */
  async claim(
    incidentId: string,
    role: IncidentRole,
    slackUserId: string,
  ): Promise<RoleAssignment> {
    const assigned_at = new Date().toISOString();
    await this.db.run(
      `INSERT INTO incident_roles (incident_id, role, slack_user_id, assigned_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(incident_id, role)
         DO UPDATE SET slack_user_id = excluded.slack_user_id,
                       assigned_at   = excluded.assigned_at`,
      [incidentId, role, slackUserId, assigned_at],
    );
    return { incident_id: incidentId, role, slack_user_id: slackUserId, assigned_at };
  }

  /** All role holders for an incident. */
  async list(incidentId: string): Promise<RoleAssignment[]> {
    return this.db.all<RoleAssignment>(
      "SELECT * FROM incident_roles WHERE incident_id = ? ORDER BY role",
      [incidentId],
    );
  }
}
