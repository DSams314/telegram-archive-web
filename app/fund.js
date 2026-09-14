// The "Apple Developer License Fund" panel at the top of Settings.
//
// Its numbers and link live in site-config.json, which the maintainer edits
// on GitHub to move the bar along or set the donation page. Everything read
// from that file is checked first: a typo there hides the panel rather than
// breaking Settings, and the link is only ever used if it is a plain https
// address.

const DEFAULTS = {
  show: true,
  title: 'Apple Developer License Fund',
  subtitle: 'for an iOS release of Telegram Archive',
  raised: 0,
  goal: 99,
  donate_url: '',
  donate_label: 'Donate',
};

const words = (value, fallback, limit = 90) =>
  (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback);

const amount = (value, fallback) =>
  (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);

function safeLink(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Read and check the fund settings. Null means: show nothing. */
export async function loadFund() {
  let raw;
  try {
    const response = await fetch('site-config.json', { cache: 'no-store' });
    if (!response.ok) return null;
    raw = (await response.json())?.fund;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.show === false) return null;

  const goal = amount(raw.goal, DEFAULTS.goal) || DEFAULTS.goal;
  return {
    title: words(raw.title, DEFAULTS.title),
    subtitle: words(raw.subtitle, DEFAULTS.subtitle, 120),
    raised: amount(raw.raised, 0),
    goal,
    link: safeLink(raw.donate_url),
    label: words(raw.donate_label, DEFAULTS.donate_label, 30),
  };
}

const money = (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function fundCard(fund) {
  const card = document.createElement('section');
  card.className = 'fund';

  const head = document.createElement('div');
  head.className = 'fund-head';
  head.append(
    Object.assign(document.createElement('b'), { textContent: fund.title }),
    Object.assign(document.createElement('span'), { textContent: fund.subtitle }),
  );

  const share = Math.min(1, fund.raised / fund.goal);
  const track = document.createElement('div');
  track.className = 'fund-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(fund.goal));
  track.setAttribute('aria-valuenow', String(Math.min(fund.raised, fund.goal)));
  track.setAttribute('aria-label', fund.title);
  const bar = document.createElement('div');
  bar.className = 'fund-bar';
  bar.style.width = `${(share * 100).toFixed(1)}%`;
  track.append(bar);

  const foot = document.createElement('div');
  foot.className = 'fund-foot';
  const figure = document.createElement('span');
  figure.className = 'fund-figure';
  figure.textContent = share >= 1
    ? `${money(fund.raised)} raised. Funded, thank you!`
    : `${money(fund.raised)} of ${money(fund.goal)}`;
  foot.append(figure);

  if (fund.link) {
    const donate = document.createElement('a');
    donate.className = 'fund-donate';
    donate.href = fund.link;
    donate.target = '_blank';
    // No referrer: the donation page learns nothing about where you came from.
    donate.rel = 'noopener noreferrer';
    donate.textContent = fund.label;
    foot.append(donate);
  } else {
    const soon = document.createElement('span');
    soon.className = 'fund-soon';
    soon.textContent = 'Donation link coming soon';
    foot.append(soon);
  }

  card.append(head, track, foot);
  return card;
}
