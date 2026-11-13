# Test what a workflow does after a write loses its reply

This is a synthetic HTTP destination, not a retry library. Use it to test the
workflow you already have. It listens on loopback and accepts no request body,
credentials or production identifiers. Node.js 22 is sufficient; there are no
dependencies. Use a self-hosted test worker that can reach the same loopback,
not an exposed URL for a production or hosted worker.

```sh
node --test lost-ack-fixture.test.mjs
node lost-ack-fixture.mjs 8788
```

For each scenario, point the cloned workflow's write node at
`POST http://127.0.0.1:8788/committed/write?ref=demo-first` or the same path
with `uncommitted`. Use an empty body. Set the write timeout below 750 ms if
you need a client-side timeout; otherwise the fixture closes the connection
without a reply. Point the lookup at `GET /committed/lookup?ref=demo-first`
or its `uncommitted` equivalent. Configure the HTTP node to pass a 404 status
to the decision step rather than automatically resending the write.

| Scenario | Early observations | Later check | Expected workflow result |
| --- | --- | --- | --- |
| `committed` | Lost write reply, then two identical 404s | Third lookup returns `fixture-1` | Use that result; do not send a second write |
| `uncommitted` | Same lost reply and two 404s | Third lookup is still 404 | Keep the outcome unresolved; no automatic write based on absence |

Three additional scenarios use the same write, lookup and report paths:

| Scenario | Observations | What to assert |
| --- | --- | --- |
| `stale-json` | The write landed. Early lookups are HTTP 200 with `{"exists":false}`, followed by the original record. | Do not resend even if the workflow's review cutoff elapses. Recover the original ID when it becomes visible. |
| `malformed-json` | The write landed. Early HTTP 200 bodies alternate between `{}` and `{"exists":"false"}`, then expose the original record. | Treat both malformed bodies as unknown, not delivered and not replayable. |
| `confirmed-no-write` | The write did not land. The ordinary lookup still returns 404; `GET /confirmed-no-write/receipt?ref=demo-first` separately returns a terminal receipt for attempt 1. | A matching, terminal `not_applied` receipt permits one newly recorded retry. Expect two write attempts and one effect. A receipt from a different reference or an already superseded attempt does not permit replay. |

The last scenario's receipt returns `ref`, `attempt`, `terminal` and
`outcome`. It remains a receipt for the first attempt after the retry; do
not reuse it for attempt 2. Before the first write, or on another reference,
there is no receipt. This is a deliberately authoritative **synthetic**
endpoint, not a claim that a real service's ordinary search has that authority.

The optional second CLI argument sets the number of stale/malformed reads
(1 to 20, default 2). For example, `node lost-ack-fixture.mjs 8788 10` can
keep the record hidden beyond a caller's short review cutoff. Run the state
assertions after each case: the committed variants still owe exactly one
effect, no matter what the workflow's success message says.

Outside the workflow, read `GET /<scenario>/report?ref=demo-first` to check
actual write attempts, lookup count and effects. Expect one write attempt in
each scenario and respectively one and zero effects. A separate negative
control sends a second write after the first 404 and observes two effects in
`committed`. This catches the bug even when both workflow branches reported
that they recovered. Use a fresh `demo-...` reference for another attempt, or
stop and restart the disposable fixture to reset all state.

On a real destination, a late positive match must be tied to the exact
original operation. Replay requires a provider-enforced idempotency key or
authoritative proof that the write did not apply. A negative lookup and an
elapsed deadline alone are neither. Use the real provider's native receipt
when it is sufficient; this fixture does not establish that provider's
consistency or the behavior of a particular n8n Cloud instance.
