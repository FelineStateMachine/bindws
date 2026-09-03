// Relay names: what a valid one looks like, which are kept back, and the
// memorable ones handed out for temporary leases.

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
export const RESERVED = new Set(["www", "api", "admin", "app", "mail", "relay", "relays", "gateway", "static", "cdn", "status", "docs", "help", "support", "abuse", "root", "ns1", "ns2", "smtp", "imap", "ftp"]);

export function validName(name: string): boolean {
  return NAME_RE.test(name) && name.length >= 3 && !RESERVED.has(name);
}

// Two short lists, read over once for pairings that read badly. A lease name
// is adjective-animal; after a few collisions it falls back to animal plus
// two digits.
export const ADJECTIVES = [
  "amber", "ancient", "autumn", "bold", "brave", "bright", "brisk", "calm", "candid", "cheerful", "civil", "clear", "clever", "cool", "copper", "cosmic", "cozy", "crisp", "curious", "daring",
  "dawn", "deep", "eager", "early", "earnest", "easy", "electric", "fair", "faithful", "fancy", "fine", "fleet", "fluent", "fond", "free", "fresh", "gentle", "gilded", "glad", "golden",
  "good", "graceful", "grand", "green", "happy", "hardy", "hearty", "hidden", "honest", "humble", "icy", "indigo", "ivory", "jade", "jolly", "keen", "kind", "lively", "lucid", "lucky",
  "lunar", "magic", "major", "marble", "mellow", "merry", "mighty", "misty", "modest", "nimble", "noble", "north", "olive", "opal", "patient", "pearl", "plain", "polar", "proud", "quick",
  "quiet", "rapid", "ready", "rosy", "royal", "ruby", "rustic", "sage", "sandy", "scarlet", "serene", "sharp", "silent", "silver", "simple", "sleek", "smart", "snowy", "solar", "solid",
  "sonic", "spry", "steady", "stellar", "still", "stormy", "sunny", "swift", "tidy", "tiny", "true", "velvet", "vivid", "warm", "wild", "windy", "wise", "witty", "young", "zesty",
];
export const ANIMALS = [
  "alpaca", "badger", "beaver", "bison", "bobcat", "camel", "capybara", "cardinal", "caribou", "cheetah", "cobra", "condor", "coyote", "crane", "cricket", "deer", "dingo", "dolphin", "dove", "eagle",
  "egret", "elk", "falcon", "ferret", "finch", "firefly", "fox", "gazelle", "gecko", "gibbon", "giraffe", "goose", "gopher", "heron", "hornet", "ibex", "ibis", "iguana", "impala", "jackal",
  "jaguar", "kestrel", "koala", "lark", "lemur", "leopard", "lion", "lizard", "llama", "lynx", "macaw", "magpie", "manatee", "marlin", "marmot", "marten", "meerkat", "mole", "moose", "moth",
  "narwhal", "newt", "ocelot", "octopus", "orca", "oriole", "osprey", "otter", "owl", "oyster", "panda", "panther", "parrot", "pelican", "penguin", "pike", "plover", "puffin", "puma", "quail",
  "rabbit", "raven", "robin", "salmon", "seal", "shrike", "sparrow", "spider", "squid", "stork", "swan", "tapir", "tern", "tiger", "toucan", "trout", "turtle", "urchin", "viper",
  "vole", "walrus", "wapiti", "weasel", "whale", "wombat", "wren", "yak", "zebra",
];

export const DEFAULT_LEASE_DAYS = 14;

// leaseDays reads LEASE_DAYS, falling back to the default.
export function leaseDays(env: { LEASE_DAYS?: string }): number {
  const n = Number(env.LEASE_DAYS);
  return Number.isInteger(n) && n > 0 && n <= 365 ? n : DEFAULT_LEASE_DAYS;
}

function rand(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

// leaseNames yields candidate names, memorable first, until one is free.
export function* leaseNames(): Generator<string> {
  const pick = (list: string[]) => list[rand(list.length)];
  for (let i = 0; i < 8; i++) yield pick(ADJECTIVES) + "-" + pick(ANIMALS);
  for (let i = 0; i < 8; i++) yield pick(ANIMALS) + String(10 + rand(90));
}
