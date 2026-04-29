import { Octokit } from "@octokit/rest";
import type { SourceEvent, SourceProvider, UserConfig } from "@cblite-uni-app/worker-core";

export class GitHubProvider implements SourceProvider {
  private tokens: Map<string, string>;

  constructor(tokens: Map<string, string>) {
    this.tokens = tokens;
  }

  async listEvents(user: UserConfig): Promise<SourceEvent[]> {
    const token = this.tokens.get(user.username);
    if (!token) {
      console.warn(`[github] No token for '${user.username}'. Skipping.`);
      return [];
    }

    const octokit = new Octokit({ auth: token });
    let notifications: Awaited<ReturnType<typeof octokit.activity.listNotificationsForAuthenticatedUser>>["data"];
    try {
      const res = await octokit.activity.listNotificationsForAuthenticatedUser({
        all: false, // unread only
        per_page: 50,
      });
      notifications = res.data;
    } catch (err) {
      console.error(`[github] Failed to list notifications for '${user.username}':`, err);
      throw err;
    }

    const events: SourceEvent[] = [];
    for (const n of notifications) {
      events.push({
        id: `github::${n.id}`,
        source: "github",
        type: notificationReason(n.reason),
        actor: n.repository.owner.login,
        title: `[${n.repository.full_name}] ${n.subject.title}`,
        body: buildBody(n),
        url: n.subject.url?.replace("api.github.com/repos", "github.com").replace("/pulls/", "/pull/") ?? n.repository.html_url,
        receivedAt: n.updated_at,
        raw: n as unknown as Record<string, unknown>,
      });
    }

    // Mark all fetched notifications as read after collecting them
    try {
      await octokit.activity.markNotificationsAsRead();
    } catch (err) {
      console.warn(`[github] Failed to mark notifications as read for '${user.username}':`, err);
    }

    return events;
  }
}

function notificationReason(reason: string): string {
  const map: Record<string, string> = {
    assign: "issue_assigned",
    review_requested: "pr_review_requested",
    mention: "mention",
    comment: "comment",
    subscribed: "subscribed_update",
    ci_activity: "ci_activity",
    author: "author_update",
    team_mention: "team_mention",
  };
  return map[reason] ?? reason;
}

function buildBody(n: { subject: { title: string; type: string }; repository: { full_name: string }; reason: string }): string {
  return `${n.subject.type} in ${n.repository.full_name}. Reason: ${n.reason}. Title: ${n.subject.title}`;
}
