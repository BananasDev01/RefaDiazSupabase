const { parseArgs, getOption, parsePositiveInteger } = require("./common");

function formatLocalDate(timeZone, date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeAnchorDate(rawDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw new Error(`Invalid anchor date. Expected YYYY-MM-DD, received: ${rawDate}`);
  }

  return rawDate;
}

function diffDays(left, right) {
  const leftUtc = Date.UTC(
    Number.parseInt(left.slice(0, 4), 10),
    Number.parseInt(left.slice(5, 7), 10) - 1,
    Number.parseInt(left.slice(8, 10), 10)
  );
  const rightUtc = Date.UTC(
    Number.parseInt(right.slice(0, 4), 10),
    Number.parseInt(right.slice(5, 7), 10) - 1,
    Number.parseInt(right.slice(8, 10), 10)
  );

  return Math.floor((leftUtc - rightUtc) / (24 * 60 * 60 * 1000));
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const cadenceDays = parsePositiveInteger(
    getOption(options, "cadence-days", process.env.CADENCE_DAYS || "3"),
    3
  );
  const anchorDate = getOption(
    options,
    "anchor-date",
    process.env.CADENCE_ANCHOR_DATE || "2026-03-10"
  );
  const timeZone = getOption(
    options,
    "time-zone",
    process.env.BACKUP_TIMEZONE || "America/Monterrey"
  );
  const today = formatLocalDate(timeZone);
  const anchor = normalizeAnchorDate(anchorDate);
  const shouldRun = diffDays(today, anchor) % cadenceDays === 0;

  if (process.env.GITHUB_OUTPUT) {
    require("fs").appendFileSync(
      process.env.GITHUB_OUTPUT,
      `should_run=${shouldRun}\n`
    );
  }

  process.stdout.write(`${shouldRun}\n`);
}

main();
