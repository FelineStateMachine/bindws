// Every event kind the relay treats specially, in one place, by the NIP
// that defines it. A module that needs one imports it from here.

// NIP-01, 09, 62, 42
export const KIND_PROFILE = 0;
export const KIND_DELETION = 5;
export const KIND_VANISH = 62;
export const KIND_AUTH = 22242;

// NIP-17 and NIP-59: the rumour and the gift wrap the relay writes its owner (notify.ts)
export const KIND_DM = 14;
export const KIND_WRAP = 1059;

// NIP-56 reports, through the socket and the /report door
export const KIND_REPORT = 1984;

// NIP-46 remote signing traffic: ephemeral, encrypted end to end, never stored.
export const KIND_NOSTR_CONNECT = 24133;

// NIP-78 application data: the views the relay signs (views.ts) and the
// card's record (card.ts). Presence is ephemeral: 20000 plus the view
// kind's 78, so a client that knows one can guess the other.
export const KIND_APP_DATA = 30078;
export const KIND_VIEW = KIND_APP_DATA;
export const KIND_PRESENCE = 20078;

// NIP-43 relay membership: the roster, the role definition, and the deltas
export const KIND_MEMBER_ADDED = 8000;
export const KIND_MEMBER_REMOVED = 8001;
export const KIND_ROSTER = 13534;
export const KIND_ROLE_DEF = 33534;
// NIP-43's own join and leave requests: ephemeral, no h tag, a claim tag
// carries the invite code.
export const KIND_NIP43_JOIN = 28934;
export const KIND_NIP43_LEAVE = 28936;

// NIP-29 groups: moderation events clients send, and the state the relay signs
export const KIND_PUT_USER = 9000;
export const KIND_REMOVE_USER = 9001;
export const KIND_EDIT_METADATA = 9002;
export const KIND_DELETE_EVENT = 9005;
export const KIND_CREATE_GROUP = 9007;
export const KIND_DELETE_GROUP = 9008;
export const KIND_CREATE_INVITE = 9009;
export const KIND_PINS = 9010;
export const KIND_JOIN = 9021;
export const KIND_LEAVE = 9022;
export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_ADMINS = 39001;
export const KIND_GROUP_MEMBERS = 39002;
export const KIND_GROUP_ROLES = 39003;
export const KIND_GROUP_PINS = 39005;

// NIP-66: the discovery record the relay signs about itself
export const KIND_RELAY_DISCOVERY = 30166;

// NIP-5A static websites and immutable manifest snapshots
export const KIND_SITE = 15128;
export const KIND_NAMED_SITE = 35128;
export const KIND_SITE_SNAPSHOT = 5128;

// Marmot Nostr transport: account KeyPackages and opaque MLS group messages.
export const KIND_MARMOT_GROUP = 445;
export const KIND_MARMOT_KEY_PACKAGE = 30443;
// NIP-34 Git repository authority and collaboration events
export const KIND_REPO = 30617;
export const KIND_REPO_STATE = 30618;
export const KIND_GIT_PATCH = 1617;
export const KIND_GIT_PR = 1618;
export const KIND_GIT_PR_UPDATE = 1619;
export const KIND_GIT_ISSUE = 1621;
