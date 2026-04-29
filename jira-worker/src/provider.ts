import axios, { type AxiosInstance } from "axios";
import type { SourceEvent, SourceProvider, UserConfig } from "@cblite-uni-app/worker-core";

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: { content?: Array<{ content?: Array<{ text?: string }> }> } | string | null;
    updated: string;
    status: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string };
    reporter?: { displayName: string };
    comment?: { comments: Array<{ id: string; body: unknown; author: { displayName: string }; created: string }> };
  };
  self: string;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
}

interface UserCreds { email: string; apiToken: string }

export class JiraProvider implements SourceProvider {
  private baseUrl: string;
  private creds: Map<string, UserCreds>;

  constructor(baseUrl: string, creds: Map<string, UserCreds>) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.creds = creds;
  }

  async listEvents(user: UserConfig): Promise<SourceEvent[]> {
    const cred = this.creds.get(user.username);
    if (!cred) { console.warn(`[jira] No credentials for '${user.username}'.`); return []; }

    const client = this.makeClient(cred);

    // JQL: all watched issues updated in the last poll window
    const jql = `watcher = currentUser() AND updated >= -${Math.ceil(
      parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "300", 10) / 60
    )}m ORDER BY updated DESC`;

    let issues: JiraIssue[];
    try {
      const res = await client.get<JiraSearchResponse>("/rest/api/3/search", {
        params: { jql, maxResults: 50, fields: "summary,description,updated,status,priority,assignee,reporter,comment" },
      });
      issues = res.data.issues;
    } catch (err) {
      console.error(`[jira] Failed to search issues for '${user.username}':`, err);
      throw err;
    }

    const events: SourceEvent[] = [];
    for (const issue of issues) {
      // Emit one event per recent comment (if any), plus one for the issue itself
      const comments = issue.fields.comment?.comments ?? [];
      const recentComments = comments.slice(-3); // last 3 comments

      if (recentComments.length > 0) {
        for (const comment of recentComments) {
          events.push({
            id: `jira::comment::${comment.id}`,
            source: "jira",
            type: "issue_comment",
            actor: comment.author.displayName,
            title: `[${issue.key}] New comment: ${issue.fields.summary}`,
            body: extractJiraText(comment.body) + `\n\nIssue status: ${issue.fields.status.name}`,
            url: `${this.baseUrl}/browse/${issue.key}`,
            receivedAt: comment.created,
            raw: { issue_key: issue.key, comment_id: comment.id, issue: issue.fields },
          });
        }
      } else {
        // Issue updated but no new comments — emit an update event
        events.push({
          id: `jira::issue::${issue.id}::${issue.fields.updated}`,
          source: "jira",
          type: "issue_updated",
          actor: issue.fields.reporter?.displayName ?? "unknown",
          title: `[${issue.key}] Updated: ${issue.fields.summary}`,
          body: [
            `Status: ${issue.fields.status.name}`,
            issue.fields.priority ? `Priority: ${issue.fields.priority.name}` : "",
            issue.fields.assignee ? `Assignee: ${issue.fields.assignee.displayName}` : "",
            extractJiraText(issue.fields.description),
          ].filter(Boolean).join("\n"),
          url: `${this.baseUrl}/browse/${issue.key}`,
          receivedAt: issue.fields.updated,
          raw: issue as unknown as Record<string, unknown>,
        });
      }
    }
    return events;
  }

  private makeClient(cred: UserCreds): AxiosInstance {
    const auth = Buffer.from(`${cred.email}:${cred.apiToken}`).toString("base64");
    return axios.create({
      baseURL: this.baseUrl,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      timeout: 15_000,
    });
  }
}

function extractJiraText(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  // Atlassian Document Format
  try {
    const adf = body as { content?: Array<{ content?: Array<{ text?: string }> }> };
    return (adf.content ?? [])
      .flatMap((block) => block.content ?? [])
      .map((inline) => inline.text ?? "")
      .join(" ")
      .trim();
  } catch { return ""; }
}
