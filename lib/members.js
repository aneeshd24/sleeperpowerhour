// Who's behind each Sleeper account: first name and headshot (assets/heads/<photo>.jpg, 320px square, face-centred).
// Keyed by Sleeper user_id, which survives display-name and team-name changes. Accounts not listed here fall back to
// their Sleeper avatar. Leave photo out until there's a headshot: the Sleeper team picture stands in for it.
export const MEMBERS = {
  // '<sleeper user_id>': { first: 'Name', photo: 'file-name-without-.jpg' },
  '1002032688821374976': { first: 'Kaushik', photo: 'kaushik' }, // kaushik47, CeeTE Jones
  '475088579287052288': { first: 'Jay', photo: 'jay' }, // jp1648, Help me i need a RB
  '738244620139540480': { first: 'Aneesh', photo: 'aneesh' }, // aneeshd24, Suck my Dak
  '888148032221319168': { first: 'Sanket', photo: 'sanket' }, // Jalapajaleno, Gibbing Head
  '1393322320495394816': { first: 'Rahul', photo: 'rahul' }, // rahulr2000, Herb's Gerbs
  '1262561563919781889': { first: 'Atharva', photo: 'atharva' }, // atharva117, Burrow my balls
  '1002672300858114048': { first: 'KP', photo: 'kp' }, // k1789, A Quarter Chuba
  '989244786685067264': { first: 'John', photo: 'john' }, // johnjjacob, Romo's Homo's
  '1263699469786955776': { first: 'Kush', photo: 'kush' }, // kuhguta, Waddle I Do w This Boner
  '1262947110249041920': { first: 'Phillip', photo: 'phillip' }, // philliam98, Skatteboner
};

// the single-file preview inlines the photos as data URIs on window.__HEADS__
export const photoUrl = (photo) => globalThis.__HEADS__?.[photo] || `assets/heads/${photo}.jpg`;
