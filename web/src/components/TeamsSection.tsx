import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { Team } from "@/types";

function TeamRow({ t }: { t: Team }) {
  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t.label}</span>
        {t.configured ? (
          <Badge variant="outline">{t.members.length} member{t.members.length === 1 ? "" : "s"}</Badge>
        ) : (
          <Badge variant="outline">not linked</Badge>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t.configured
          ? t.members.length > 0
            ? t.members.map((m) => `@${m}`).join(", ")
            : "Linked, but the group has no members (or membership couldn’t be read)."
          : "Link a Slack user group in config to populate this team."}
      </p>
    </div>
  );
}

export function TeamsSection() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [optins, setOptins] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .fetchTeams()
      .then((r) => {
        setTeams(r.teams);
        setOptins(r.stakeholder_optins);
      })
      .catch((e) => setErr(String((e as Error).message)))
      .finally(() => setLoaded(true));
  }, []);

  if (err) return null; // teams are supplementary; don't blow up the page
  if (!loaded) return null;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Response teams <span className="opacity-70">(linked Slack groups · managed in Slack)</span>
        </h2>
        <Card>
          <CardContent className="p-0">
            {teams.map((t, i) => (
              <div key={t.key}>
                {i > 0 && <Separator />}
                <TeamRow t={t} />
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Stakeholder opt-ins <span className="opacity-70">(via the Slack Home tab)</span>
        </h2>
        <Card>
          <CardContent className="px-4 py-3 text-sm">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-medium">Opted-in stakeholders</span>
              <Badge variant="outline">{optins.length}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {optins.length > 0
                ? optins.map((u) => `@${u}`).join(", ")
                : "No one has opted in yet. Anyone can opt in from the app’s Slack Home tab."}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Everyone here — plus the linked <span className="font-medium">Stakeholders</span> group above — is
              auto-invited to every new incident channel.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
