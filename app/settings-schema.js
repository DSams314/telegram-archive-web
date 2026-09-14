// Every setting, declared once.
//
// The panel renders from this list, the search box filters this list, defaults
// come from this list, and CSS-backed settings apply themselves through the
// `cssVar` field. Adding a setting means adding one entry here -- there is no
// second place to update, which is what keeps a long settings screen honest.
//
// Fields:
//   id       storage key
//   group    section heading
//   label    what the user reads
//   help     one-line explanation, also searched
//   type     toggle | select | range | color | text | action | info
//   cssVar   custom property to write on <html> (with `format` if not literal)
//   reload   changing it needs the open chat re-rendered
//   keywords extra search terms that aren't in the label
//   modes    ['server'] or ['web'] if it only makes sense in one version

export const GROUPS = [
  'Appearance',
  'Chat',
  'Media',
  'Archive',
  'Advanced',
];

import { MODE } from './mode.js';

const px = (v) => `${v}px`;
const ms = (v) => `${v}ms`;

export const SETTINGS = [
  // ---- Appearance ------------------------------------------------------
  {
    id: 'theme', group: 'Appearance', label: 'Colour theme', type: 'select',
    default: 'dark', keywords: 'dark light mode night',
    options: [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']],
    help: 'Follow the system setting or pin one.',
  },
  {
    id: 'accent', group: 'Appearance', label: 'Accent colour', type: 'color',
    default: '#3e8ef7', cssVar: '--accent',
    help: 'Your own bubbles, links, and highlights.',
    presets: ['#3e8ef7', '#7c6cf0', '#e0699a', '#e08a4b', '#57b96a', '#4fb3c7'],
  },
  {
    id: 'wallpaper', group: 'Appearance', label: 'Chat background', type: 'wallpaper',
    default: 'default', keywords: 'wallpaper background image photo upload custom',
    options: [['default', 'Sunset'], ['deep', 'Deep'], ['slate', 'Slate'],
              ['plain', 'Plain'], ['custom', 'Your photo']],
    help: 'Built-in backgrounds, or upload your own photo.',
  },
  {
    id: 'wallpaperDim', group: 'Appearance', label: 'Background dimming',
    type: 'range', default: 0, min: 0, max: 70, step: 5, unit: '%',
    cssVar: '--wallpaper-dim', format: (v) => v / 100,
    help: 'Darkens the background so bubbles read more easily.',
  },
  {
    id: 'panelBlur', group: 'Appearance', label: 'Panel blur', type: 'range',
    default: 24, min: 0, max: 48, step: 2, unit: 'px',
    cssVar: '--blur', format: px, keywords: 'frosted glass translucent',
    help: 'Frosting behind the sidebar, header and panels.',
  },
  {
    id: 'bubbleOpacity', group: 'Appearance', label: 'Bubble opacity',
    type: 'range', default: 88, min: 40, max: 100, step: 2, unit: '%',
    cssVar: '--bubble-alpha', format: (v) => v / 100,
    help: 'How much background shows through message bubbles.',
  },
  {
    id: 'bubbleRadius', group: 'Appearance', label: 'Bubble corner radius',
    type: 'range', default: 14, min: 2, max: 22, step: 1, unit: 'px',
    cssVar: '--radius-bubble', format: px, keywords: 'rounded square corners',
  },
  {
    id: 'fontSize', group: 'Appearance', label: 'Message text size',
    type: 'range', default: 14, min: 11, max: 20, step: 1, unit: 'px',
    cssVar: '--font-size', format: px, keywords: 'font bigger smaller',
  },
  {
    id: 'density', group: 'Appearance', label: 'Compact spacing', type: 'toggle',
    default: false, cssVar: '--msg-gap', format: (v) => (v ? '0px' : '2px'),
    help: 'Tightens the gap between messages.',
  },

  // ---- Chat ------------------------------------------------------------
  {
    id: 'clock24', group: 'Chat', label: '24-hour time', type: 'toggle',
    default: false, reload: true, keywords: 'time format am pm military',
  },
  {
    id: 'showSenderNames', group: 'Chat', label: 'Show sender names in 1:1 chats',
    type: 'toggle', default: false, reload: true,
    help: 'Group chats always show them.',
  },
  {
    id: 'groupWindow', group: 'Chat', label: 'Group messages sent within',
    type: 'range', default: 300, min: 0, max: 900, step: 30, unit: 's',
    reload: true, keywords: 'stacking runs consecutive',
    help: 'Consecutive messages from one person merge into a run.',
  },
  {
    id: 'showReactions', group: 'Chat', label: 'Show reactions', type: 'toggle',
    default: true, reload: true, keywords: 'emoji reaction',
  },
  {
    id: 'showReplyPreviews', group: 'Chat', label: 'Show quoted replies',
    type: 'toggle', default: true, reload: true,
    help: 'The quoted message above a reply.',
  },
  {
    id: 'showEdited', group: 'Chat', label: 'Mark edited messages',
    type: 'toggle', default: true, reload: true,
  },
  {
    id: 'showMessageIds', group: 'Chat', label: 'Show message IDs',
    type: 'toggle', default: false, reload: true,
    help: 'Telegram’s internal id on each message. Useful for debugging.',
  },

  // ---- Media -----------------------------------------------------------
  {
    id: 'autoplayGifs', group: 'Media', label: 'Autoplay GIFs', type: 'toggle',
    default: true, keywords: 'animation motion loop',
    help: 'Only ever plays what is on screen.',
  },
  {
    id: 'autoplayStickers', group: 'Media', label: 'Autoplay video stickers',
    type: 'toggle', default: true, keywords: 'webm animated',
  },
  {
    id: 'mediaWidth', group: 'Media', label: 'Maximum media width',
    type: 'range', default: 420, min: 220, max: 640, step: 20, unit: 'px',
    reload: true, keywords: 'photo video size big',
  },
  {
    id: 'stickerSize', group: 'Media', label: 'Sticker size', type: 'range',
    default: 180, min: 90, max: 280, step: 10, unit: 'px', reload: true,
  },
  {
    id: 'showAbsent', group: 'Media', label: 'Show placeholders for missing files',
    type: 'toggle', default: true, reload: true,
    keywords: 'absent deleted not downloaded shimmer',
    help: 'Draws a correctly-shaped box where media was not exported.',
  },
  {
    id: 'shimmer', group: 'Media', label: 'Animate missing-file placeholders',
    type: 'toggle', default: true, cssVar: '--shimmer',
    format: (v) => (v ? 'running' : 'paused'),
  },

  // ---- Archive ---------------------------------------------------------
  {
    id: 'backupRoot', group: 'Archive', label: 'Backup folder', type: 'text',
    default: '', saveTo: 'config', browse: true, modes: ['server'],
    keywords: 'path directory location source browse choose folder picker',
    help: 'Where your exports live. Saved to disk; rebuild the index after changing it.',
  },
  {
    id: 'volumeStatus', group: 'Archive', label: 'Storage', type: 'status',
    modes: ['server'],
    keywords: 'drive disk external network nas usb connected mounted detected',
    help: 'Whether the backup folder is on this computer, a drive, or a network share.',
  },
  {
    id: 'archiveFolder', group: 'Archive', label: 'Archive folder', type: 'folder',
    modes: ['web'], keywords: 'backup folder location change open choose different',
    help: 'The folder Telegram Archive reads your exports from.',
  },
  {
    id: 'configFile', group: 'Archive', label: 'Settings file', type: 'configfile',
    modes: ['web'],
    keywords: 'save config export download backup settings file load import restore',
    help: 'Your settings, name and pictures, kept in '
      + 'telegram-archive-config.json in your archive folder.',
  },
  {
    id: 'selfId', group: 'Archive', label: 'Your Telegram ID', type: 'text',
    default: '', reload: true, saveTo: 'config',
    keywords: 'from_id account me owner',
    help: 'Which side of every conversation is you. Auto-detected when possible.',
  },
  {
    id: 'selfName', group: 'Archive', label: 'Your display name', type: 'text',
    default: '', reload: true, saveTo: 'config',
  },
  {
    id: 'selfAvatar', group: 'Archive', label: 'Your profile photo',
    type: 'action', action: 'selfAvatar', keywords: 'picture avatar me',
    help: 'Chat pictures are set from each chat’s profile panel.',
  },
  {
    id: 'rebuild', group: 'Archive', label: 'Rebuild the index', type: 'action',
    action: 'rebuild', keywords: 'reindex refresh update scan',
    help: 'Run after adding a new export.',
  },
  {
    id: 'rerunSetup', group: 'Archive', label: 'Run first-time setup again',
    type: 'action', action: 'rerunSetup', keywords: 'wizard onboarding welcome',
    help: 'Goes through the welcome steps again. Nothing is deleted.',
  },
  {
    id: 'exportHelp', group: 'Archive', label: 'How to export your chats',
    type: 'action', action: 'openHelp',
    keywords: 'telegram desktop export instructions guide help json where put',
    help: 'Getting your chats out of Telegram Desktop and into your folder, step by step.',
  },

  // ---- Advanced --------------------------------------------------------
  {
    id: 'diagnostics', group: 'Advanced', label: 'Save diagnostics',
    type: 'action', action: 'diagnostics',
    keywords: 'log logs report bug problem support troubleshoot send',
    help: 'Writes a report you can send to whoever is helping you. Names and '
      + 'personal paths are removed from it first.',
  },
  {
    id: 'shutdownOnClose', group: 'Advanced', type: 'toggle', default: false,
    modes: ['server'],
    label: 'Shut down when this window closes',
    keywords: 'quit exit stop server close tab window automatically',
    help: 'Stops the program about half a minute after the last window '
      + 'closes. Reloading or leaving it in the background is fine.',
  },
  {
    id: 'importTheme', group: 'Advanced', label: 'Import a Telegram theme',
    type: 'action', action: 'importTheme',
    keywords: 'attheme tdesktop palette colours skin',
    help: 'Accepts .attheme, .tdesktop-theme and .tdesktop-palette files.',
  },
  {
    id: 'clearTheme', group: 'Advanced', label: 'Clear imported theme',
    type: 'action', action: 'clearTheme',
  },
  {
    id: 'reduceMotion', group: 'Advanced', label: 'Reduce motion', type: 'toggle',
    default: false, keywords: 'animation spring accessibility',
    help: 'Turns off springs and transitions.',
  },
  {
    id: 'animationSpeed', group: 'Advanced', label: 'Animation speed',
    type: 'range', default: 340, min: 80, max: 700, step: 20, unit: 'ms',
    cssVar: '--dur', format: ms,
  },
  {
    id: 'exportSettings', group: 'Advanced', label: 'Export settings to a file',
    type: 'action', action: 'exportSettings', keywords: 'backup save json',
    modes: ['server'],
  },
  {
    id: 'importSettings', group: 'Advanced', label: 'Import settings from a file',
    type: 'action', action: 'importSettings', keywords: 'restore load json',
    modes: ['server'],
  },
  {
    id: 'forgetFolder', group: 'Advanced', label: 'Forget this folder on this device',
    type: 'action', action: 'forgetFolder', danger: true, modes: ['web'],
    keywords: 'privacy clear remove delete browser storage cache shared computer',
    help: 'Removes the remembered folder, the index and the copy of your settings '
      + 'from this browser. Your folder and its settings file are not touched.',
  },
  {
    id: 'reset', group: 'Advanced', label: 'Reset everything to defaults',
    type: 'action', action: 'reset', danger: true,
  },
];

export const BY_ID = new Map(SETTINGS.map((s) => [s.id, s]));

export const DEFAULTS = Object.fromEntries(
  SETTINGS.filter((s) => s.type !== 'action').map((s) => [s.id, s.default]),
);

/** Whether a setting belongs in the version of the app that is running. */
export const available = (setting) => !setting.modes || setting.modes.includes(MODE);

/** Free-text match across label, help, group and keywords. */
export function matches(setting, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = [setting.label, setting.help, setting.group, setting.keywords]
    .filter(Boolean).join(' ').toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}
