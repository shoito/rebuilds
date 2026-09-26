// REQ-DLV-015: label PRs merged without the required approval (admin bypass, ADR-0004).
import type { GitHub } from "./github.ts";

export const LABEL = "review:post-merge";

export interface Review {
  user: { login: string } | null;
  state: string;
}

/**
 * True when no one other than the author has an effective approval. Reviews are in
 * chronological order; COMMENTED does not change a reviewer's previous state.
 */
export function mergedWithoutApproval(author: string, reviews: Review[]): boolean {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (!r.user || r.user.login === author) continue;
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.login, r.state);
  }
  return ![...latest.values()].includes("APPROVED");
}

export async function labelIfBypassed(gh: GitHub, pr: number): Promise<boolean> {
  const info = await gh.get<{ user: { login: string }; merged: boolean }>(`/repos/{repo}/pulls/${pr}`);
  if (!info.merged) return false;
  const reviews = await gh.get<Review[]>(`/repos/{repo}/pulls/${pr}/reviews?per_page=100`);
  if (!mergedWithoutApproval(info.user.login, reviews)) return false;
  await gh.request("POST", `/repos/{repo}/issues/${pr}/labels`, { labels: [LABEL] });
  return true;
}
