import axios from "axios";
import type { SourceEvent, SourceProvider, UserConfig } from "@cblite-uni-app/worker-core";

interface GitLabTodo {
  id: number;
  action_name: string;
  target_type: string;
  target: { title: string; web_url: string; description?: string; iid: number };
  project: { path_with_namespace: string };
  author: { username: string };
  created_at: string;
  body?: string;
}

export class GitLabProvider implements SourceProvider {
  private baseUrl: string;
  private tokens: Map<string, string>;

  constructor(baseUrl: string, tokens: Map<string, string>) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.tokens = tokens;
  }

  async listEvents(user: UserConfig): Promise<SourceEvent[]> {
    const token = this.tokens.get(user.username);
    if (!token) { console.warn(`[gitlab] No token for '${user.username}'.`); return []; }

    let todos: GitLabTodo[];
    try {
      const res = await axios.get<GitLabTodo[]>(`${this.baseUrl}/api/v4/todos`, {
        headers: { "PRIVATE-TOKEN": token },
        params: { per_page: 50 },
        timeout: 15_000,
      });
      todos = res.data;
    } catch (err) {
      console.error(`[gitlab] Failed to fetch todos for '${user.username}':`, err);
      throw err;
    }

    // Mark all fetched todos as done
    try {
      await axios.post(`${this.baseUrl}/api/v4/todos/mark_as_done`, {}, {
        headers: { "PRIVATE-TOKEN": token },
        timeout: 10_000,
      });
    } catch (err) {
      console.warn(`[gitlab] Failed to mark todos as done for '${user.username}':`, err);
    }

    return todos.map((t) => ({
      id: `gitlab::todo::${t.id}`,
      source: "gitlab",
      type: `${t.target_type.toLowerCase()}_${t.action_name}`,
      actor: t.author.username,
      title: `[${t.project.path_with_namespace}] ${t.target_type} ${t.action_name}: ${t.target.title}`,
      body: t.body ?? t.target.description ?? "",
      url: t.target.web_url,
      receivedAt: t.created_at,
      raw: t as unknown as Record<string, unknown>,
    }));
  }
}
