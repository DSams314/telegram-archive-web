// Which kind of Telegram Archive this page is running as.
//
//   'web'     the website: runs entirely in your browser and reads a folder
//             you choose; there is no server of ours involved at all
//   'server'  the downloadable app: a small program on your own computer
//
// This file says 'web'. The downloadable app's own server answers requests
// for it with 'server' instead (see serve.py), so one copy of the code runs
// as both without two builds to keep in step.

export const MODE = 'web';
