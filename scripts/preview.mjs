import { loadConfig, loadEnvFile, getProjectDir } from './config.mjs';
import { scrapeSearch } from './x-scrape.mjs';
import { filterAndClassify } from './filter.mjs';
import { triage, MUTED, PRIORITY } from './tier.mjs';
import { classify, createClient } from './classify.mjs';
import { planAnnouncements, summarizeChain, chainIdOf } from './chain.mjs';
import { printWarning } from './notify-terminal.mjs';

loadEnvFile(getProjectDir());

let config;
try {
  config = loadConfig();
} catch (err) {
  printWarning(err.message);
  process.exit(1);
}

const { mutedHandles, teamHandles } = config;
const { source, tweets } = await scrapeSearch(config);
const classified = filterAndClassify(tweets, config);
const client = createClient(config.anthropicApiKey);

console.log(
  `query=${config.searchQuery}\n` +
    `source=${source} tweets=${classified.length} ` +
    `muted=[${mutedHandles.join(',') || '-'}] team=[${teamHandles.join(',') || '-'}] ` +
    `classifier=${client ? 'on' : 'off'}\n`,
);

let calls = 0;
const rows = [];
for (const tweet of classified) {
  const pre = triage(tweet, { mutedHandles, teamHandles });
  let verdict = null;
  if (pre.tier !== MUTED && client) {
    verdict = await classify(tweet, { client });
    calls += 1;
    if (!verdict.ok) console.log(`  !! classify failed: ${verdict.error}`);
  }
  rows.push({ tweet, decision: triage(tweet, { mutedHandles, teamHandles, verdict }), verdict });
}

for (const { tweet, decision, verdict } of rows) {
  const mark = decision.tier === PRIORITY ? '*' : decision.tier === MUTED ? '-' : ' ';
  const llm = (verdict?.ok ? verdict.tier : 'n/a').padEnd(8);
  console.log(
    `${mark} ${decision.tier.padEnd(8)} score=${String(decision.score).padStart(2)} llm=${llm} ` +
      `@${tweet.author.padEnd(17)} via=${tweet.matchedVia.padEnd(6)} ` +
      `f=${String(tweet.followers ?? '?').padStart(6)} ` +
      tweet.text.replace(/\s+/g, ' ').slice(0, 56),
  );
  if (verdict?.ok && verdict.reason) console.log(`${' '.repeat(15)}${verdict.reason}`);
}

const counts = rows.reduce((acc, r) => ({ ...acc, [r.decision.tier]: (acc[r.decision.tier] || 0) + 1 }), {});
console.log(`\ntiers: ${JSON.stringify(counts)} | classifier calls: ${calls}`);

// What Slack would actually receive. The budget starts empty here: preview
// reads no store, so this is one poll on a quiet thread history, not what a
// running watcher would do mid-flood.
const plan = planAnnouncements(
  rows.filter((r) => r.decision.tier !== MUTED).map(({ tweet, decision }) => ({ tweet, decision })),
  { limit: config.chainLimit },
);

console.log(`\nslack lines: ${plan.length} (from ${rows.length} mentions, budget ${config.chainLimit}/thread)`);
for (const item of plan) {
  if (item.type === 'post') {
    console.log(
      `  ${item.decision.tier === PRIORITY ? '*' : ' '} @${item.tweet.author.padEnd(17)} ` +
        `${chainIdOf(item.tweet)}`,
    );
    continue;
  }
  const summary = summarizeChain(item.entries);
  console.log(
    `  + CHAIN ${summary.count} more in ${item.chainId} ` +
      `(${summary.authors.map((a) => `@${a}`).join(', ')}${summary.moreAuthors ? ` +${summary.moreAuthors}` : ''})`,
  );
}

console.log('Nothing was posted to Slack and no state was written.');
