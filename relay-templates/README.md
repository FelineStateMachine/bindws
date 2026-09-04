# Relay templates

One file per template, in the order the console shows them. Each is a relay
configuration (`relay-config.schema.json`) with a `template` block for the
title and the blurb, and the rules sections only: policy, kinds and
retention. People, bans and addresses are never in a template, and a section
a template leaves out is left alone when it is applied.

`npm run build:templates` folds the folder into `src/gen/templates.ts`, which
the relay serves as its presets; `npm run typecheck` checks every file here
against the schema and the relay's parser, and fails when the generated
module is stale.

To try one on a relay without applying it:

```
node scripts/ops/relay.mjs plan relay-templates/10-quiet.jsonc wss://<name>.bind.ws
```
