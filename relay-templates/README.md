# Relay templates

A relay does not have to do everything. Names are cheap, so pick the template
for the job and give each job its own name. The console offers these as
presets, in this order; each is also a file you can apply from a script or
copy as the start of your own.

| Template | Choose it when |
|---|---|
| [default](01-default.jsonc) | you want a plain relay: anyone writes, anyone reads, everything kept. What a fresh claim has. |
| [outbox](02-outbox.jsonc) | it is where your own public notes and articles live, for the world to read. |
| [inbox](03-inbox.jsonc) | it is where people reach you: replies, reactions, zaps and reports, kept 90 days. |
| [private](04-private.jsonc) | only you write and only your devices or a trusted few read: drafts, wallets, app data. |
| [chat](05-chat.jsonc) | a group of members talks here: messages and the group's chat, directory hidden. |
| [media](06-media.jsonc) | it is a file host and nothing else: members upload, anyone fetches. |
| [search](07-search.jsonc) | you want a searchable copy of another relay's prose, refreshed every six hours. Needs a source. |
| [articles](08-articles.jsonc) | long-form only, yours or mirrored daily from a source. |
| [dm](09-dm.jsonc) | it is a drop box for private messages: anyone leaves a gift wrap, only members read. |
| [quiet](10-quiet.jsonc) | it should cost nothing and announce nothing: members only, every optional feature off, switched on one at a time as needed. |
| [site](11-site.jsonc) | it hosts NIP-5A static websites: members publish manifests and files, with mirroring on. |
| [marmot](12-marmot.jsonc) | it carries Marmot KeyPackages, opaque group messages and private welcomes. |
| [grasp](13-grasp.jsonc) | it hosts GRASP Git repositories: admitted members publish repository state and related events, with reads open. |

Each file says more in its comment: what the template does, which Haven relay
it mirrors, and why its kinds are what they are.

## The files

A template is a relay configuration (`$schema` names the copy served at
`https://bind.ws/relay-config.schema.json`, the same file as `../relay-config.schema.json`) with a
`template` block for the title and the blurb, and the rules sections only:
policy, kinds and retention. People, bans and addresses are never in a
template, and a section a template leaves out is left alone when it is
applied. The number in the file name is the order the console shows them in.

`npm run build:templates` folds the folder into `src/gen/templates.ts`, which
the relay serves as its presets; `npm run typecheck` checks every file here
against the schema and the relay's parser, fails when the generated module
is stale, and fails when a file is missing from the table above.

To try one on a relay without applying it, from the repository root:

```
npm run relay plan relay-templates/10-quiet.jsonc wss://<name>.bind.ws
```
