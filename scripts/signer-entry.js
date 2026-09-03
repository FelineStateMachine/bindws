// The browser half of NIP-46 for the relay console: bundled by
// build-signer.mjs into src/gen/signer.ts and served at /signer.js.
// Loaded only when someone picks a remote signer, since NIP-44 and
// secp256k1 are not in WebCrypto.
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { BunkerSigner, parseBunkerInput, createNostrConnectURI } from "nostr-tools/nip46";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

window.NostrSigner = { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, BunkerSigner, parseBunkerInput, createNostrConnectURI, npubEncode, bytesToHex, hexToBytes };
