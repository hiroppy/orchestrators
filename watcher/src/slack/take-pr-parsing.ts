import { parse as parseYaml } from "yaml";

export function parseGitHubPullRequestUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const slackLink = value.match(/^<([^|>]+)(?:\|[^>]*)?>$/)?.[1] ?? value;
  try {
    const url = new URL(slackLink);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function projectSlugFromWorkflow(workflow: string): string | undefined {
  const frontmatter = workflow.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return undefined;

  try {
    const document = parseYaml(frontmatter) as {
      tracker?: { provider?: { project_slug?: unknown } };
    } | null;
    const projectSlug = document?.tracker?.provider?.project_slug;
    if (typeof projectSlug !== "string") return undefined;
    return projectSlug.trim() || undefined;
  } catch {
    return undefined;
  }
}
