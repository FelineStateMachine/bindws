---
title: List recovery
audience: user
---

Your relay keeps up to twelve older versions of your follows, relay lists and bookmark lists. The versions stay private to the key that published them and do not appear in ordinary queries, dumps or search.

Open the Data tab in your relay console to see saved versions. Restore prepares the old tags and content as a new event with a current timestamp. Your browser extension or remote signer signs it, and the console publishes the signed event through the normal event door. The relay never receives or stores your private key.

History starts when a list is replaced, so a newly claimed relay has no older version until you publish a newer list. Author deletion and NIP-62 vanish remove the saved versions as well.
