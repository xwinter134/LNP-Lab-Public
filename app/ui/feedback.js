// Feedback: a problem or an idea, sent as a GitHub issue or, for anyone without a GitHub account, as an e-mail.
//
// The app holds no account and no key, so it cannot file the issue itself: a key shipped inside a public app
// could be read out of it and used by anyone. It opens GitHub's "new issue" page instead, filled in with the
// screen, the version and the browser, and the person sends it from their own GitHub account; the maintainer is
// notified as for any issue. The e-mail way opens the mail program with the same text, when FEEDBACK_EMAIL is
// set. Nothing of the lab's records goes with either: not the address's parameters (they hold record ids), not a
// value, not a name.

/** Where issues are filed. One place to change it, if the project moves. */
export const ISSUES_URL = 'https://github.com/xwinter134/LNP-Lab-Public/issues/new';
/** Where feedback by e-mail goes; empty hides that way. It is public, being in the app's code. */
export const FEEDBACK_EMAIL = 'support.lnplab@gmail.com';

const KINDS = {
  bug: { title: 'Problem', label: 'bug', ask: '**What happened?**\n\n\n**What did you expect instead?**\n\n\n**Steps to get there** (if you know them)\n1. \n' },
  idea: { title: 'Idea', label: 'enhancement', ask: '**What would help?**\n\n\n**What are you trying to do when you miss it?**\n\n' },
};

/** The browser and system in a few words, from the user agent, for "it only happens in Safari". */
function browserName(ua = globalThis.navigator?.userAgent || '') {
  const m = (re) => re.exec(ua)?.[1];
  const b = m(/Edg\/(\d+)/) ? `Edge ${m(/Edg\/(\d+)/)}` : m(/Chrome\/(\d+)/) ? `Chrome ${m(/Chrome\/(\d+)/)}`
    : m(/Firefox\/(\d+)/) ? `Firefox ${m(/Firefox\/(\d+)/)}` : m(/Version\/([\d.]+) .*Safari/) ? `Safari ${m(/Version\/([\d.]+) .*Safari/)}` : 'unknown browser';
  const mac = m(/Mac OS X ([\d_]+)/);
  const os = mac ? `macOS ${mac.replace(/_/g, '.')}` : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' on ');
}

/**
 * The address of a pre-filled new issue. `screen` is the screen's id and title only, never the rest of the address.
 * @param {'bug'|'idea'} kind
 * @param {{screen?: string, title?: string, version?: string, app?: boolean, ua?: string}} where
 */
export function feedbackUrl(kind, where = {}) {
  const k = KINDS[kind] || KINDS.idea;
  const q = new URLSearchParams({ title: subject(kind, where), body: feedbackText(kind, where), labels: k.label });
  return `${ISSUES_URL}?${q.toString()}`;
}

/** The same, as a mailto: address for the mail program; null when no feedback address is set. */
export function feedbackMail(kind, where = {}) {
  if (!FEEDBACK_EMAIL) return null;
  // mailto wants %20, not the + URLSearchParams writes for a space.
  const enc = (x) => encodeURIComponent(x).replace(/%0A/g, '%0D%0A');
  return `mailto:${FEEDBACK_EMAIL}?subject=${enc(`LNP Lab · ${subject(kind, where)}`)}&body=${enc(feedbackText(kind, where).replace(/\*\*/g, '').replace(/<!--|-->/g, ''))}`;
}

const subject = (kind, { screen = '', title = '' } = {}) => `${(KINDS[kind] || KINDS.idea).title}: ${title || screen || ''}`.trim();

function feedbackText(kind, { screen = '', title = '', version = '', app = false, ua } = {}) {
  const k = KINDS[kind] || KINDS.idea;
  return `${k.ask}
---
**Where:** ${title || screen || 'unknown'}${screen ? ` (\`#/${screen}\`)` : ''}
**Version:** LNP Lab v${version || '?'} (${app ? 'macOS app' : 'browser'})
**Browser:** ${browserName(ua)}

<!-- Nothing from your lab is attached. A screenshot helps; leave out anything confidential. -->
`;
}

/** Open an address outside the app: the system browser from the macOS app, a new tab in a browser. */
export function openExternal(url) {
  if (!url) return null;
  const opener = globalThis.__TAURI__?.opener;
  if (opener?.openUrl) return opener.openUrl(url);
  if (url.startsWith('mailto:')) { globalThis.location.href = url; return null; }
  globalThis.open?.(url, '_blank', 'noopener');
  return null;
}
