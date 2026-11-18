# Server selection — Windows 0.4.1-rc.3

This describes the Windows release-candidate source prepared on 18 November 2026. Android remains at `0.5.0-rc.4`; its UI is separate. Download availability is tracked in [RELEASES.md](RELEASES.md).

## From an application to a server

The existing application chooser stays unchanged. After selecting an app, service or address, its route opens one server-selection screen:

| Choice | Behavior |
| --- | --- |
| Automatic | Choose among eligible personal connections and keep a working path. Public servers do not join Auto. |
| Manual → Saved | Search the connection library and select a compact server row. Ten entries per numbered page. |
| Manual → Public servers | Search the entire stored pool, filter by region and availability, and select a server. Twelve entries per numbered page. |
| Direct | Send this target through the provider without changing the other routes. |

The public source is a visible tab, not a collapsed appendix. The route diagram, backup choice and advanced matching options live under **Parameters and connections**. Existing application-selection tiles are preserved.

## Availability is separate from pool size

A downloaded endpoint is a candidate, not evidence of a working connection. The catalogue presents a fresh-success count separately from the stored pool size. When fresh results exist at entry, **Available now** is the initial filter. Otherwise it shows actionable candidates and starts one bounded search. Filters and pages do not change underneath a user who has started browsing.

Entering an empty catalogue requests its sources. Entering a cached catalogue without fresh successes requests one verification round. There is no startup-wide or periodic scan. Refresh and verification remain available while the main VPN is running; a local checker uses a proxy listener, creates no TUN, and does not replace the current session.

Selecting an unchecked or stale candidate performs a targeted check through that exact node before importing it. A failed check reports the reason and leaves the app's route unchanged. The target check takes precedence over the bulk round. Displayed latency is an HTTP-check observation, not game-server ping or a promise of future availability.

Search and pagination operate against the full stored pool. The short snapshots used for progress updates no longer limit browsing to 200 candidates.

## Changing an active route

Normal card changes use live routing updates. Selecting a server that was not loaded at VPN startup can prepare a separate local forwarding worker while the existing main TUN stays owned by the master switch. Card edits do not request a whole-VPN restart. A failed live application restores the previous saved selection and reports the failure.

A successful path change may close connections belonging to the edited rule so they can reconnect through the new server. Unrelated routes retain their VPN session. The owner's global OFF command takes precedence over pending verification and route changes.

The interface locks the card's toggle/removal only while its specific selection is in progress. Browsing and pool verification do not acquire that lock. Leaving the picker while a check is pending prevents a late callback from activating the abandoned selection.

## Verification and images

Regression coverage includes full-pool search beyond the old sample, page replacement, stale observations, checks while ON, failed candidate selection and preservation of master intent. Backend checks cover targeted verification and live routing; Windows CI remains the place for the native process, real TUN and production-renderer gates.

The screenshots already in [the gallery](screenshots/README.md) predate this picker. They are labelled accordingly until fresh production-renderer captures have been reviewed. Passing UI fixtures does not establish that a particular third-party server works on the user's network.
