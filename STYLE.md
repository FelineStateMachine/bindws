# Style

How this repository writes things down: prose, commits, comments, code and
tests. Every rule is drawn from what is already here, so this file describes
the repository rather than an opinion about it.

## The through-line

**Say what is true, not what was done or what to do.** Present indicative,
active, no hedging. This one habit produces most of the rest of this file.

| Instead of | Write |
|---|---|
| Add a catalog table to the templates README | the README is a catalog, one line per template on when to choose it |
| You can switch features off | a relay's information document lists what its owner left on |
| Store the blob and return it | storeBlob puts bytes in R2 and a row in the table unless the hash is already there |

The reason travels with the fact, in the same sentence, when the reason is not
obvious:

> it is a generated module rather than a text-module rule in `wrangler.jsonc`
> because celld deploy refuses a config with `rules`

> the celld suite runs on demand in its own workflow, since the runner's
> timing makes the sync test flaky on every push

Sentences are short. Fragments are fine when they are deliberate. There is no
marketing voice, no filler, and no sentence whose only job is to introduce the
next one.

## Commits

The form is `<area>: <what is now true>`, lowercase after the colon.

```
views: a view's setting is its trigger or off; the owner picks on write, hourly or daily for a stored view and on or off for presence, the scheduler and the write-time republish read it, and true or false still mean the default and off
kinds: every special event kind in one module, by NIP; 30078 had three names in three files, and the NIP-46 and report kinds lived in relay.ts
docs: main takes commits, not pull requests
```

- **The area** is the module, folder or concern the change belongs to:
  `views`, `kinds`, `config`, `routes`, `console`, `docs`, `test`, `ci`,
  `host`, `rules`, `relay-templates`, `scripts`, `tidy`.
- **No imperative mood and no Conventional Commits.** There is no `feat:`,
  `fix:`, `chore:`, and no "add", "update" or "refactor" opening a subject.
- **Length is not a constraint.** The median subject is 75 characters and the
  longest is 332. Clauses join with commas and semicolons. Say the whole
  thing.
- **The body stays empty.** One commit in 167 has one. If a subject needs a
  body, it is usually two commits.
- **Say why when why is not obvious**, in the same subject.
- **No attribution or co-author trailers.**

Each commit typechecks on its own.

## Documentation

- `docs/` is numbered with two digits: `00` to `05` for users, `10` to `16`
  for developers, `20` and up for draft NIPs the repository implements ahead
  of upstream.
- Each file opens with frontmatter naming its `title` and its `audience`
  (`user` or `developer`).
- `README.md` is the front door. It links every doc with a one-line gloss of
  what that doc answers.
- Cross-link by relative path, using the target's own title as the link text.
- User docs use "you" and "your relay". Developer docs describe the system in
  the third person.
- A tutorial names an npm script, never `node` and a path. Every tool has an
  npm name, and the docs, the file headers and the workflow use it.
- Anything with more than about three parallel facts becomes a table.

## Comments

**Module headers** say what the module is, why it exists, and what its surface
looks like. A list of routes or a small diagram belongs here.

```ts
// The relay card: something a name can be linked to from a profile.
//
//   GET /card.json   the facts: name, owner, members, rules, fuel, naddr, nprofile
//   GET /card.svg    an open graph sized picture with a QR of the naddr
//
// Cards are public and cached for five minutes. Unclaimed and leased relays
// get a smaller card that says so.
```

**Function comments open with the function's own name**, then say what it
does and what it returns.

```ts
// blobBlocked says whether a hash was removed by a moderator: a resolved
// report puts the sha256 on the banned id list, so it cannot come back
// through any door.
```

A comment that restates its code is deleted. A comment that records a
constraint, a reason or a surprise is kept.

## Code

- TypeScript with explicit `.ts` in import paths.
- **A function returns `""` on success and the reason on failure**, rather
  than throwing or returning a bare boolean. Callers read the reason and pass
  it on.
- **Reasons carry a NIP-01 prefix.** The vocabulary in use, by frequency:
  `invalid:`, `restricted:`, `blocked:`, `error:`, `auth-required:`,
  `unsupported:`, `duplicate:`, `pow:`, and the bare `not found`. Do not
  invent a new prefix without a reason.
- **One registry per concern, read by everything that needs it.** `ROUTES`
  in `routes.ts`, `METHODS` in `manage.ts`, `VIEWS` in `views.ts`,
  `FEATURE_NAMES` in `settings.ts`, every special kind in `kinds.ts`, the
  presets in `presets.ts`. The failure this prevents is on the record: three
  lists in three files that had to agree.
- Small helpers are arrow consts. Long lines are fine.
- **Modules are extracted from `relay.ts` when it grows.** The gates, fuel,
  views, succession, invites, routes and the information document each left it
  for a module of their own.
- Generated files (`src/gen/`) are committed, and `npm run typecheck` fails
  when one is stale.
- Unused locals fail the typecheck.

## The console

Already written down in `docs/12-develop-extend.md`, repeated here because it
is style:

- No middle dots.
- No purposeless subtext.
- Tables scroll inside their card on narrow screens.
- Decorative elements are not selectable.
- A multi-field form uses the labelled grid, not one row of inputs.
- The copy above a block is one sentence.
- New pages stay inside the shared shell in `ui.ts`.

## Tests

- `test/unit` is pure functions on node. `test/object` runs in workerd, one
  file per feature or module. `test/conformance` is black box, one file per
  NIP.
- **A test file is named after the module it exercises**, not the NIP. A NIP
  number names a file only where the feature has no other name (`nip05`,
  `nip11`, `nip66`).
- Test descriptions are full sentences saying what holds: "are all on by
  default, and setpolicy takes a map that survives export and import".
- `test/object/exposure.test.ts` walks every door as a stranger and as a
  signed-in non-member. **Every new path is added to its list.**

## Typography

ASCII punctuation only. The README, every doc and every source file contain
zero em-dashes, en-dashes, middle dots and smart quotes. This is measured, not
aspirational.

- Never the middle dot `U+00B7`, in any file, for any purpose. Use a comma, a
  hyphen or a pipe.
- No em-dash or en-dash. Start a new sentence, or use a comma or a colon.
- Straight quotes and apostrophes.

## Catalogs that must not drift

Several lists are load-bearing, and some are enforced by the build. Adding a
file means adding its row.

| Catalog | Where | Enforced |
|---|---|---|
| one row per template | `relay-templates/README.md` | yes, the build fails without it |
| one link per doc | `README.md` | by review |
| one entry per generated file | `src/gen/` staleness check | yes, in `npm run typecheck` |
| every door | `test/object/exposure.test.ts` | by review |
| every special kind | `src/kinds.ts` | by review |
| the supported NIP list | `src/nip11.ts` | by review |
