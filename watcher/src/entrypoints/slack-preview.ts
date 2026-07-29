#!/usr/bin/env node

import { WebClient } from "@slack/web-api";

import {
  postSlackPreview,
  resolveSlackPreviewCase,
  resolveSlackPreviewConfig,
} from "../slack/preview.ts";

try {
  const previewCase = resolveSlackPreviewCase(
    process.argv.slice(2).find((value) => value !== "--"),
  );
  const { botToken, channelId } = resolveSlackPreviewConfig();
  const response = await postSlackPreview(new WebClient(botToken), channelId, previewCase);
  console.log(`Slack preview posted to ${response.channel ?? channelId} (ts: ${response.ts}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
