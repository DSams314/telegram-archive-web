// The single source of truth for the build number.
//
// Shown beside the Settings heading and reported in the run banner, so a copy
// someone else is running can always be identified.

export const VERSION = '1.31';
export const VERSION_LABEL = `Version ${VERSION}`;

// The index format this build understands. The indexer stamps the same
// number into manifest.json; a mismatch means the index on disk was
// written by a different version and has to be rebuilt before it is read,
// rather than half-loaded into confusing breakage.
export const INDEX_SCHEMA = 1;
