// Public API: everything a feed.config.ts needs.
export type * from "./types.ts";
export { FEED_ITEM_CONTRACT } from "../contracts/feed-item.ts";
export { LEDGER_CONTRACT } from "../contracts/ledger.ts";
export { feed, parseFeed } from "../sources/feed.ts";
export { inbox } from "../sources/inbox.ts";
export { wiki } from "../sinks/wiki.ts";
export { page } from "../sinks/page.ts";
export { jsonl, hindsight, webhook, memoryText } from "../sinks/deliveries.ts";
export { reviewQueue, pendingReviews, reviewRows } from "../sinks/review.ts";
export { voiceInbox } from "../sinks/voice.ts";
export { youtube } from "../sources/youtube.ts";
export { openAICompatible } from "./model.ts";
export { writeDigest } from "./digest.ts";
export { runCli } from "./cli.ts";
export { guard } from "./guard.ts";
export { parseIntent } from "./intent.ts";

import type { FeedConfig } from "./types.ts";
export const defineFeed = (c: FeedConfig): FeedConfig => c;
