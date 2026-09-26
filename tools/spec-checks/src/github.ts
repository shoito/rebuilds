// Minimal GitHub REST client for the scheduled workflows.

export type Fetch = typeof fetch;

export class GitHub {
  readonly repo: string;
  readonly token: string;
  readonly fetch: Fetch;

  constructor(repo: string, token: string, fetchImpl: Fetch = fetch) {
    this.repo = repo;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("https://") ? path : `https://api.github.com${path.replace("{repo}", this.repo)}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * Creates an issue with `title`, or comments on the open one with the same title.
   * Labels follow docs/project-management.md sections 3 and 5 (type: Task).
   */
  async ensureIssue(title: string, body: string, labels: string[]): Promise<{ action: "created" | "commented"; number: number }> {
    const open = await this.get<{ number: number; title: string; pull_request?: unknown }[]>(
      `/repos/{repo}/issues?state=open&labels=${encodeURIComponent("source:alert")}&per_page=100`,
    );
    const existing = open.find((i) => i.title === title && !i.pull_request);
    if (existing) {
      await this.request("POST", `/repos/{repo}/issues/${existing.number}/comments`, { body });
      return { action: "commented", number: existing.number };
    }
    let created: { number: number };
    try {
      created = await this.request("POST", "/repos/{repo}/issues", { title, body, labels, type: "Task" });
    } catch {
      // Issue types exist only for organization repositories; retry without the type.
      created = await this.request("POST", "/repos/{repo}/issues", { title, body, labels });
    }
    return { action: "created", number: created.number };
  }
}
