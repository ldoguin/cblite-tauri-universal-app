import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import type { Poller, SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";

export function startWebhookServer(
  port: number,
  webhookSecret: string | undefined,
  users: UserConfig[],
  poller: Poller
): void {
  const server = createServer((req, res) => {
    handle(req, res, webhookSecret, users, poller).catch((err) => {
      console.error("[github-webhook] Error:", err);
      res.writeHead(500).end();
    });
  });
  server.listen(port, () => console.log(`[github-webhook] Listening on port ${port}`));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string | undefined,
  users: UserConfig[],
  poller: Poller
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/webhook") { res.writeHead(404).end(); return; }

  const body = await readBody(req);

  if (secret) {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!sig || !verifySignature(body, secret, sig)) {
      res.writeHead(401).end("Invalid signature");
      return;
    }
  }

  res.writeHead(200).end("OK");

  const event = req.headers["x-github-event"] as string;
  const payload = JSON.parse(body) as Record<string, unknown>;
  const sourceEvent = githubPayloadToEvent(event, payload);
  if (!sourceEvent) return;

  // Route to the repo owner or sender if they match a configured user
  const sender = (payload["sender"] as Record<string, string> | undefined)?.["login"]?.toLowerCase();
  const user = users.find((u) => u.username.toLowerCase() === sender) ?? users[0];
  if (user) await poller.processEvent(sourceEvent, user);
}

function githubPayloadToEvent(event: string, payload: Record<string, unknown>): SourceEvent | null {
  const repo = (payload["repository"] as Record<string, string> | undefined)?.["full_name"] ?? "";
  const sender = (payload["sender"] as Record<string, string> | undefined)?.["login"] ?? "";
  const action = payload["action"] as string | undefined;

  if (event === "issues") {
    const issue = payload["issue"] as Record<string, unknown>;
    return {
      id: `github-webhook::issues::${(issue["id"] as number)}::${action}`,
      source: "github", type: `issue_${action}`, actor: sender,
      title: `[${repo}] Issue ${action}: ${issue["title"]}`,
      body: (issue["body"] as string | undefined) ?? "",
      url: issue["html_url"] as string ?? "",
      receivedAt: new Date().toISOString(),
      raw: payload,
    };
  }
  if (event === "pull_request") {
    const pr = payload["pull_request"] as Record<string, unknown>;
    return {
      id: `github-webhook::pr::${(pr["id"] as number)}::${action}`,
      source: "github", type: `pr_${action}`, actor: sender,
      title: `[${repo}] PR ${action}: ${pr["title"]}`,
      body: (pr["body"] as string | undefined) ?? "",
      url: pr["html_url"] as string ?? "",
      receivedAt: new Date().toISOString(),
      raw: payload,
    };
  }
  if (event === "issue_comment" || event === "pull_request_review") {
    const comment = (payload["comment"] ?? payload["review"]) as Record<string, unknown>;
    return {
      id: `github-webhook::${event}::${(comment["id"] as number)}`,
      source: "github", type: event, actor: sender,
      title: `[${repo}] New ${event.replace("_", " ")} by ${sender}`,
      body: (comment["body"] as string | undefined) ?? "",
      url: comment["html_url"] as string ?? "",
      receivedAt: new Date().toISOString(),
      raw: payload,
    };
  }
  return null;
}

function verifySignature(body: string, secret: string, sig: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
