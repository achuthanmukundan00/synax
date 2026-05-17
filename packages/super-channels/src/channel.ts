import type { SuperRunRequest, SuperRunResult } from "../../super-core/src/types.ts";

export interface SuperChannelAdapter {
  readonly id: string;
  start?(handler: (id: string, request: SuperRunRequest) => Promise<SuperRunResult>): Promise<void>;
  stop?(): Promise<void>;
}

export type SuperInboundMessage = {
  id: string;
  channel: string;
  conversationId: string;
  userId?: string;
  text: string;
};
