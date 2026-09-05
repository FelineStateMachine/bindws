# Connection templates

An app shortcut on a relay's Connect fold is one of these files, chosen by
the owner. Each says which app opens, what it does with this relay, and the
links that hand a viewer over to it, written once with placeholders the
relay fills in for whoever is looking. One good template works for anyone.

| Template | Choose it when |
|---|---|
| [notes](01-notes.jsonc) | the relay is a feed and Jumble should open it as one. |
| [find-me](02-find-me.jsonc) | feed apps should meet this relay through the owner's profile with the relay attached. |
| [group](03-group.jsonc) | the relay's group is a room, in Flotilla or any group-aware app. |
| [blog](04-blog.jsonc) | the owner writes articles and YakiHonne should open them with this relay attached. |
| [repos](05-repos.jsonc) | the relay hosts Git repositories; GitWorkshop opens them and the clone command names yours. |
| [sites](06-sites.jsonc) | the relay hosts NIP-5A sites: the owner's, the viewer's own, and the nsyte command that publishes one. |
| [bookmarks](07-bookmarks.jsonc) | signed-in viewers keep bookmarks and lists here and Listr should manage them. |
| [photos](08-photos.jsonc) | the owner's photos live on this relay's file store and only the owner should see the shortcut; the read rule, not the shortcut, says who may see the files. |
| [files](09-files.jsonc) | members keep files on this relay's Blossom store and bouquet should manage them. |
| [dm](10-dm.jsonc) | the relay is a DM inbox and people should message the owner privately from here. |
| [marmot](11-marmot.jsonc) | the relay carries Marmot groups and White Noise is the app. |
| [relay-page](12-relay-page.jsonc) | Coracle should open the relay's page: its feed and its people. |

## The files

A template is a JSON document (`$schema` names the copy served at
`https://bind.ws/connection-template.schema.json`, the same file as
`../connection-template.schema.json`) with a title, one sentence about it,
the app, where the app runs, an icon, the links, and optionally the feature
the shortcut needs, the visibility it starts with, what its QR carries and
the inputs the owner fills in when adding it. An input whose value lands in
a URL path or a shell command names a `pattern` the value must match, so
what the owner types cannot change the link or the command around it. The
fold has one relay URL copy control of its own, so a template does not
carry one.

Links and the QR text carry placeholders:

| Placeholder | Fills in |
|---|---|
| `{relay:url}` `{relay:host}` `{relay:web}` `{relay:name}` `{relay:domain}` | `wss://name.bind.ws`, `name.bind.ws`, `https://name.bind.ws`, `name`, `bind.ws` (where NIP-5A sites live) |
| `{relay:hex}` `{relay:npub}` `{relay:nprofile}` `{relay:naddr}` | the relay's own key, and the group address |
| `{owner:hex}` `{owner:npub}` `{owner:nprofile}` | the owner, the nprofile with this relay as the hint |
| `{user:hex}` `{user:npub}` `{user:nprofile}` | whoever is signed in and looking; a link that needs one is not shown to a visitor |
| `{input:<name>}` | what the owner typed into the template's input of that name |

A `|enc` suffix, as in `{relay:url|enc}`, percent-encodes the value for a
query string. The number in the file name is the order the library shows
them in.

`npm run build:connections` folds the folder into `src/gen/connections.ts`,
which the relay serves as its library; `npm run typecheck` checks every file
here against the schema and the placeholder vocabulary, fails when the
generated module is stale, and fails when a file is missing from the table
above. A relay template in `../relay-templates/` names these in its
`connections` section, so one preset sets the rules and the shortcuts
together ([Connection templates](../docs/17-connection-templates.md)).
