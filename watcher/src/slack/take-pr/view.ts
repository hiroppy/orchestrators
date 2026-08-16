import type { KnownBlock } from "@slack/web-api";
import type { ServiceDefinition } from "../../domain/service.ts";
import { escapeSlackLinkLabel } from "../view-formatting.ts";
import {
  TAKE_PR_CONFIRM_ACTION_ID,
  TAKE_PR_SERVICE_ACTION_ID,
  MAX_OPTION_TEXT_LENGTH,
  type CompletePullRequest,
} from "./types.ts";
import { singleLine } from "./validation.ts";

export function buildTakePrServiceSelectionBlocks(
  requestId: string,
  pullRequest: CompletePullRequest,
  services: ServiceDefinition[],
): KnownBlock[] {
  const options = services.map(({ name }, index) => ({
    text: { type: "plain_text" as const, text: name.slice(0, MAX_OPTION_TEXT_LENGTH) },
    value: `${requestId}:i${index}`,
  }));
  const repositoryName = pullRequest.repository.split("/").at(-1)?.toLowerCase();
  const inferredServiceIndex = services.findIndex(
    ({ name }) => name.toLowerCase() === repositoryName,
  );
  const initialOption = options[inferredServiceIndex];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Take existing PR*\n<${pullRequest.url}|${escapeSlackLinkLabel(`${pullRequest.repository}#${pullRequest.number ?? "?"}: ${singleLine(pullRequest.title)}`)}>`,
      },
    },
    {
      type: "actions",
      block_id: `take-pr:${requestId}`,
      elements: [
        {
          type: "static_select",
          action_id: TAKE_PR_SERVICE_ACTION_ID,
          placeholder: { type: "plain_text", text: "Service" },
          options,
          ...(initialOption ? { initial_option: initialOption } : {}),
        },
        {
          type: "button",
          action_id: TAKE_PR_CONFIRM_ACTION_ID,
          text: { type: "plain_text", text: "OK" },
          style: "primary",
          value: requestId,
        },
      ],
    },
  ];
}
