import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { Team } from "@/types";

export function TeamsSection() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.fetchTeams().then(setTeams).catch((e) => setErr(String((e as Error).message)));
  }, []);

  if (err) return null; // teams are supplementary; don't blow up the page

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Teams <span className="opacity-70">(linked Slack groups · managed in Slack)</span>
      </h2>
      <Card>
        <CardContent className="p-0">
          {teams.map((t, i) => (
            <div key={t.key}>
              {i > 0 && <Separator />}
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
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
