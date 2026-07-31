const DEFAULT_TIMEOUT_MS = 10_000;

export async function downloadSlackFile(
  downloadUrl: string,
  botToken: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  const url = new URL(downloadUrl);
  if (url.protocol !== "https:" || !isSlackHostname(url.hostname)) {
    throw new Error(`Refusing to download a file from a non-Slack URL: ${url.hostname}`);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Slack file download returned HTTP ${response.status}.`);
  }
  return response.arrayBuffer();
}

function isSlackHostname(hostname: string): boolean {
  return hostname === "slack.com" || hostname.endsWith(".slack.com");
}
