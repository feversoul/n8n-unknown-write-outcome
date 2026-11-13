# Third-party code

`lost-ack-fixture/` is the "Lost write reply: synthetic acceptance fixture for workflows" gist by epistemedeus, copied unchanged:

- Source: https://gist.github.com/epistemedeus/71ebf25d59978bc30a14f1d9a8900f68
- Revision: `043b5722867efbd7ae33874b1d465d72e6845b07` (2026-11-09)
- License: MIT, see `lost-ack-fixture/LICENSE-LOST-ACK.txt`

It is only run inside the `fixture` container of the compose files, read-only. `docker/fixture-host.mjs` (part of this repository) imports its `createFixture()` and puts it on the compose network; the gist's own command binds to loopback, which another container cannot reach.
