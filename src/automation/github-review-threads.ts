import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReviewSnapshot, ReviewThread } from "./review-loop.ts";

const execFileAsync = promisify(execFile);
const GITHUB_CLI_TIMEOUT_MS = 30_000;
const GITHUB_CLI_MAX_BUFFER = 1024 * 1024 * 10;

const REVIEW_THREADS_QUERY = `
query($owner:String!,$repo:String!,$number:Int!,$threadsCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number
      state
      headRefOid
      reviewThreads(first:100, after:$threadsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(last:100) { nodes { id body createdAt updatedAt author { login } } }
        }
      }
    }
  }
}`;

const CI_CONTEXTS_QUERY = `
query($owner:String!,$repo:String!,$number:Int!,$contextsCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      commits(last:1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first:100, after:$contextsCursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun { status conclusion }
                  ... on StatusContext { state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export async function fetchGithubReviewThreads(repoRef: string, prNumber: number): Promise<ReviewSnapshot> {
	const [owner, repo] = repoRef.split("/");
	if (!owner || !repo) throw new Error("repo must be OWNER/REPO");
	const threads: ReviewThread[] = [];
	let cursor: string | undefined;
	let headSha = "";
	let state = "UNKNOWN";
	const ciContexts = await fetchAllCiContexts(owner, repo, prNumber);
	for (;;) {
		const args = ["api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${prNumber}`];
		if (cursor) args.push("-F", `threadsCursor=${cursor}`);
		const { stdout } = await execFileAsync("gh", args, { maxBuffer: GITHUB_CLI_MAX_BUFFER, timeout: GITHUB_CLI_TIMEOUT_MS });
		const payload = JSON.parse(stdout) as GithubPayload;
		if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors));
		const pr = payload.data.repository.pullRequest;
		headSha = pr.headRefOid;
		state = pr.state;
		threads.push(...pr.reviewThreads.nodes.map((thread) => ({
			id: thread.id,
			isResolved: thread.isResolved,
			isOutdated: thread.isOutdated,
			path: thread.path,
			line: thread.line,
			comments: thread.comments.nodes,
		})));
		if (!pr.reviewThreads.pageInfo.hasNextPage) break;
		cursor = pr.reviewThreads.pageInfo.endCursor;
	}
	return { repo: repoRef, prNumber, headSha, state, threads, ciBlocking: hasBlockingCiContext(ciContexts) };
}

async function fetchAllCiContexts(owner: string, repo: string, prNumber: number): Promise<GithubCiContext[]> {
	const contexts: GithubCiContext[] = [];
	let cursor: string | undefined;
	for (;;) {
		const args = ["api", "graphql", "-f", `query=${CI_CONTEXTS_QUERY}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${prNumber}`];
		if (cursor) args.push("-F", `contextsCursor=${cursor}`);
		const { stdout } = await execFileAsync("gh", args, { maxBuffer: GITHUB_CLI_MAX_BUFFER, timeout: GITHUB_CLI_TIMEOUT_MS });
		const payload = JSON.parse(stdout) as GithubCiPayload;
		if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors));
		const page = payload.data.repository.pullRequest.commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts;
		if (!page) break;
		contexts.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) break;
		cursor = page.pageInfo.endCursor;
	}
	return contexts;
}

export function hasBlockingCiContext(contexts: GithubCiContext[]): boolean {
	return contexts.some((context) => {
		if (context.__typename === "CheckRun" && "status" in context) return context.status !== "COMPLETED" || !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(context.conclusion ?? "");
		if (context.__typename === "StatusContext" && "state" in context) return context.state !== "SUCCESS";
		return false;
	});
}

type GithubCiContext =
	| { __typename: "CheckRun"; status: string; conclusion?: string | null }
	| { __typename: "StatusContext"; state: string }
	| { __typename: string };

interface GithubCiPayload {
	errors?: unknown[];
	data: {
		repository: {
			pullRequest: {
				commits: { nodes: Array<{ commit: { statusCheckRollup?: GithubStatusCheckRollup | null } }> };
			};
		};
	};
}

interface GithubPayload {
	errors?: unknown[];
	data: {
		repository: {
			pullRequest: {
				number: number;
				state: string;
				headRefOid: string;
				reviewThreads: {
					pageInfo: { hasNextPage: boolean; endCursor?: string };
					nodes: Array<{
						id: string;
						isResolved: boolean;
						isOutdated: boolean;
						path?: string | null;
						line?: number | null;
						comments: { nodes: Array<{ id: string; body: string; createdAt?: string; updatedAt?: string; author?: { login?: string } | null }> };
					}>;
				};
			};
		};
	};
}

interface GithubStatusCheckRollup {
	contexts: {
		pageInfo: { hasNextPage: boolean; endCursor?: string };
		nodes: GithubCiContext[];
	};
}
