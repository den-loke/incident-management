/// <reference types="@cloudflare/workers-types" />
// Jira issue-tracker client. Swappable behind this interface; Jira is the
// day-one target. Real impl uses Jira Cloud REST v3 (create issue). See ROADMAP.

export interface CreatedIssue {
  key: string;
  url: string;
}

export interface IssueTracker {
  /** Create an issue; returns its key + browse URL. */
  createIssue(summary: string, descriptionText: string): Promise<CreatedIssue>;
}

export interface JiraConfig {
  baseUrl: string; // https://acme.atlassian.net
  email: string;
  apiToken: string;
  projectKey: string;
  issueType?: string; // default "Task"
}

/** Real Jira Cloud client (REST v3, basic auth email:token). */
export class JiraClient implements IssueTracker {
  constructor(private readonly cfg: JiraConfig) {}

  private authHeader(): string {
    // btoa is available in workerd.
    return `Basic ${btoa(`${this.cfg.email}:${this.cfg.apiToken}`)}`;
  }

  async createIssue(summary: string, descriptionText: string): Promise<CreatedIssue> {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        authorization: this.authHeader(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        fields: {
          project: { key: this.cfg.projectKey },
          issuetype: { name: this.cfg.issueType ?? "Task" },
          summary: summary.slice(0, 250),
          // Jira v3 uses Atlassian Document Format for description.
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: descriptionText }],
              },
            ],
          },
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`jira create failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { key?: string };
    if (!data.key) throw new Error("jira create returned no key");
    return { key: data.key, url: `${base}/browse/${data.key}` };
  }
}

/** Deterministic fake tracker for tests/local dev. */
export class FakeIssueTracker implements IssueTracker {
  created: { summary: string; descriptionText: string }[] = [];
  private seq = 0;

  async createIssue(summary: string, descriptionText: string): Promise<CreatedIssue> {
    this.created.push({ summary, descriptionText });
    this.seq += 1;
    const key = `INC-${this.seq}`;
    return { key, url: `https://jira.example/browse/${key}` };
  }
}
