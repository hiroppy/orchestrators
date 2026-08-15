import type {
  ChatGetPermalinkArguments,
  ChatGetPermalinkResponse,
  ChatPostMessageArguments,
  ChatPostMessageResponse,
  ChatUpdateArguments,
  ChatUpdateResponse,
  UsersInfoArguments,
  UsersInfoResponse,
  UsersListArguments,
  UsersListResponse,
} from "@slack/web-api";

export interface SlackClient {
  chat: {
    getPermalink(args: ChatGetPermalinkArguments): Promise<ChatGetPermalinkResponse>;
    postMessage(
      args: ChatPostMessageArguments & { client_msg_id?: string },
    ): Promise<ChatPostMessageResponse>;
    update(args: ChatUpdateArguments): Promise<ChatUpdateResponse>;
  };
  users?: {
    info(args: UsersInfoArguments): Promise<UsersInfoResponse>;
    list?(args: UsersListArguments): Promise<UsersListResponse>;
  };
}
