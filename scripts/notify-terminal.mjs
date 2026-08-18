const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export const MAX_BODY = 240;

const KIND_LABEL = {
  mention: 'mention',
  reply: 'reply',
  quote: 'quote',
};

export function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function stamp(date) {
  return date.toTimeString().slice(0, 8);
}

function body(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

export function formatTweet(tweet, now = new Date()) {
  const kind = KIND_LABEL[tweet.kind] ?? tweet.kind;
  return (
    `${C.dim}[${stamp(now)}]${C.reset} ${C.yellow}${C.bold}NEW MENTION${C.reset} ` +
    `${C.cyan}@${tweet.author}${C.reset} ${C.dim}·${C.reset} ${kind}\n` +
    `  ${body(tweet.text)}\n` +
    `  ${C.dim}${tweet.url}${C.reset}`
  );
}

export function printTweet(tweet) {
  console.log(formatTweet(tweet));
}

export function printStarted(pollMs, projectDir) {
  console.log(
    `${C.bold}@entirehq mention watcher started${C.reset} ` +
      `(polling every ${Math.round(pollMs / 1000)}s) ${C.dim}[${projectDir}]${C.reset}`,
  );
}

export function printBaseline(count) {
  console.log(
    `${C.dim}[${stamp(new Date())}]${C.reset} tracking ${count} existing ` +
      `${count === 1 ? 'mention' : 'mentions'} — watching for new ones`,
  );
}

export function printQuiet(message) {
  console.log(`${C.dim}[${stamp(new Date())}] ${message}${C.reset}`);
}

export function printWarning(message) {
  console.log(`${C.red}${C.bold}[${stamp(new Date())}] ${message}${C.reset}`);
}
