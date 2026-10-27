// Who's behind each Sleeper account: first name and headshot (assets/heads/<photo>.jpg, 320px square, face-centred).
// Keyed by Sleeper user_id, which survives display-name and team-name changes. Accounts not listed here fall back to
// their Sleeper avatar.
export const MEMBERS = {
  // '<sleeper user_id>': { first: 'Name', photo: 'file-name-without-.jpg' },
};

// the single-file preview inlines the photos as data URIs on window.__HEADS__
export const photoUrl = (photo) => globalThis.__HEADS__?.[photo] || `assets/heads/${photo}.jpg`;
