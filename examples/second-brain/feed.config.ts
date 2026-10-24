// The demo: feed a second brain from the people who shaped the current memory debate.
//   bun ../../src/core/cli.ts run          (from this folder; or `bun run demo` from the repo root)
// Then open brain/index.md in Obsidian or any editor, or brain.html in a browser.
//
// No key needed. Two optional extras, both off unless you set them:
//   FEED_LLM_BASE_URL + FEED_LLM_MODEL (+ FEED_LLM_API_KEY)  model grading through any OpenAI-compatible endpoint
//   HINDSIGHT_URL (+ HINDSIGHT_API_KEY)                       hand the strongest items to a Hindsight memory bank

import { defineFeed, feed, inbox, wiki, page, hindsight, jsonl, openAICompatible, type ModelConfig, type Rule } from "../../src/core/index.ts";

const HINDSIGHT = process.env.HINDSIGHT_URL;
const LLM = process.env.FEED_LLM_BASE_URL && process.env.FEED_LLM_MODEL;

// A small, fixed label set keeps model labels comparable across runs.
const model: ModelConfig | undefined = LLM
  ? {
      port: openAICompatible({ baseUrl: process.env.FEED_LLM_BASE_URL!, model: process.env.FEED_LLM_MODEL!, apiKey: () => process.env.FEED_LLM_API_KEY }),
      taxonomy: ["Agent memory", "Agentic engineering", "Sovereignty", "Security", "Models", "Other"],
      maxCallsPerRun: 30,
    }
  : undefined;

const rules: Rule[] = [
  // The wiki keeps everything: it is the archive view, rebuilt from the ledger.
  { name: "archive", to: ["wiki"], priority: "archive" },
  // The page shows only what touches one of my projects.
  { name: "on-a-project", when: { projects: ["*"], score: { gte: 40 } }, to: ["wiki", "page"], priority: "daily" },
  // Strong memory items go to the memory engine as well.
  ...(HINDSIGHT ? [{ name: "to-memory", when: { labels: ["Agent memory"], score: { gte: 60 } }, to: ["memory"], priority: "daily" } as Rule] : []),
];

export default defineFeed({
  dataDir: "./data",
  intent: "./intent.md",
  ...(model ? { model } : {}),
  sinks: {
    wiki: wiki({ dir: "./brain", title: "Second brain" }),
    page: page({ path: "./brain.html", title: "Second brain: what the feed found today" }),
    pipe: jsonl(),
    ...(HINDSIGHT ? { memory: hindsight({ baseUrl: HINDSIGHT, bank: "second-brain", apiKey: process.env.HINDSIGHT_API_KEY }) } : {}),
  },
  jobs: {
    "memory-research": {
      sources: [
        feed({ name: "Andrej Karpathy · blog", url: "https://karpathy.github.io/feed.xml", trust: "high", limit: 5 }),
        feed({ name: "Andrej Karpathy · gists", url: "https://gist.github.com/karpathy.atom", trust: "high", kind: "code" }),
        feed({ name: "Daniel Miessler", url: "https://danielmiessler.com/feed", trust: "high", limit: 15 }),
        feed({ name: "Nate B. Jones · Substack", url: "https://natesnewsletter.substack.com/feed", trust: "high", limit: 15 }),
        feed({ name: "Open Brain (OB1) · commits", url: "https://github.com/NateBJones-Projects/OB1/commits/main.atom", kind: "code", limit: 10 }),
        feed({ name: "Hindsight · releases", url: "https://github.com/vectorize-io/hindsight/releases.atom", kind: "release", limit: 5 }),
        feed({
          name: "arXiv · agent memory",
          url: "https://export.arxiv.org/api/query?search_query=all:%22agent%20memory%22&sortBy=submittedDate&sortOrder=descending&max_results=15",
          kind: "paper",
          limit: 15,
        }),
      ],
      rules,
    },
    notes: {
      sources: [inbox({ name: "Inbox", dir: "./inbox" })],
      rules,
    },
  },
});
