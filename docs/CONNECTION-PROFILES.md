# Contributing connection profiles and checks

Waarp currently combines three separate pieces: a service preset selects destinations, a route's `connectionUse` describes its intended use, and a diagnostic checks an explicit address through available paths. Contributions are source changes reviewed in a pull request. There is no external profile manifest importer or plugin API for these features.

## Where to contribute

| Change | Windows | Android |
| --- | --- | --- |
| Service names, domain suffixes and optional CIDRs | [`PRESETS`](../src/shared/presets.ts) | `ServicePreset` and `Presets.all` in [`Models.kt`](../android/app/src/main/java/local/waarp/android/data/Models.kt) |
| Use categories and interpretation of HTTP samples | [`connection-quality.ts`](../src/shared/connection-quality.ts) | [`ConnectionQuality.kt`](../android/app/src/main/java/local/waarp/android/data/ConnectionQuality.kt) |
| Suggested diagnostic address | `suggestedProbeTarget` in `connection-quality.ts` | Route editor in [`HomeRoutes.kt`](../android/app/src/main/java/local/waarp/android/ui/HomeRoutes.kt) |
| Run, cancel and validate checks | [`index.ts`](../src/main/index.ts), [`diagnosis.ts`](../src/main/diagnosis.ts) | [`MobileViewModel.kt`](../android/app/src/main/java/local/waarp/android/MobileViewModel.kt), [`MobileRepository.kt`](../android/app/src/main/java/local/waarp/android/data/MobileRepository.kt) |
| User-facing explanations | [`ru.json`](../src/shared/strings/ru.json), [`analyzer.tsx`](../src/renderer/src/pages/analyzer.tsx) | `ConnectionUses.coverage` and [`RouteConnectionCheck.kt`](../android/app/src/main/java/local/waarp/android/ui/RouteConnectionCheck.kt) |

The two preset lists are maintained separately. For a service supported on both platforms, update both lists in the same PR and explain any intentional difference.

## A service preset

These are **fixture-only source examples**, not importable configuration. Keep fake domains in tests; use documented service destinations in a real preset.

Windows, inside `PRESETS`:

```ts
{
  id: 'fixture-service',
  name: 'Fixture service',
  hint: 'Website and account API',
  color: '#9bb06e',
  domains: ['fixture.example', 'cdn-fixture.example']
}
```

Android, inside `Presets.all`:

```kotlin
ServicePreset(
    id = "fixture-service",
    name = "Fixture service",
    hint = "Website and account API",
    domains = listOf("fixture.example", "cdn-fixture.example"),
)
```

Use a stable, unique `id`: saved routes refer to it. `domains` contains host names, without schemes, URL paths, ports or `*.`. Routing compiles these entries as domain suffixes; a parent domain already includes its subdomains, so avoid redundant entries in a production change. Add optional `cidrs` only with evidence for the exact ranges and their ownership. A shared CDN range can redirect unrelated applications.

In the PR, link the service's official documentation or another reproducible primary source for each addition. State which functions the addresses cover: website, sign-in, media delivery, voice signalling, or another explicit function. A routing rule that includes a voice domain does not prove that voice media works through a selected tunnel.

The first preset domain is currently offered as the editable diagnostic address. Choose that order deliberately. The program does not have a separate preset `probeUrl`, protocol capability list or quality score field; adding such a field requires implementation and tests, not just adding a JSON key.

## Route purpose: `connectionUse`

Both platforms use the same values:

| Value | Intended use |
| --- | --- |
| `general` | General use; also the default for old routes or unknown stored metadata |
| `web` | Web and application access |
| `interactive` | Calls and communication |
| `game` | Games |

For example, an existing route may contain this metadata fragment:

```json
{ "connectionUse": "game" }
```

This is part of a route, not a standalone import file and not a tunnel configuration option. It changes the explanation of what a check covers. It does not select TCP versus UDP, change DNS, MTU, transport settings or native routing, and it does not turn an HTTP response into a game-quality result. Keep serialization compatible with existing routes. A new category needs coordinated type/model, validation, migration, UI and test changes on both platforms.

## Diagnostic addresses and honest evidence

A user can edit the suggested address before checking. A service preset supplies its first domain; a simple custom host can supply its explicit address. Application routes require a user-entered target: an executable name or Android package name is not a domain. Address validation remains in [`probeTarget`](../src/main/validate.ts) on Windows and `NetworkTools.target` in [`NetworkTools.kt`](../android/app/src/main/java/local/waarp/android/data/NetworkTools.kt) on Android. Use HTTPS for a cross-platform example, such as `https://fixture.example/` in an intercepted test.

A new real target should be a public, stable, small endpoint with a documented relationship to the function being checked. Explain expected responses and redirects. Do not embed account tokens, private addresses, subscriptions or authenticated URLs. A provider homepage or status page may answer while account login, voice or a game session fails; describe that limited coverage.

The contextual check currently makes bounded HTTP checks through existing native APIs. Preserve these distinctions:

- Response counts, median HTTP timing and the spread of those timings describe the performed checks. They are not packet loss, network jitter, ICMP RTT or application latency.
- An unmeasured or cancelled path stays unmeasured. It must not become a failed sample.
- A responding current path is retained even when another small sample has a lower timing. A replacement recommendation requires completed failures of the current path and consistent responses from the alternative across the two rounds.
- HTTP evidence does not verify UDP reachability, voice quality, game login, gameplay, throughput or a live application session. Missing coverage must remain visible.
- Evidence belongs to the checked target, route, purpose, network and native context. Route/profile edits, a changed effective path, cancellation and expiry must prevent an old recommendation from being applied. Current proofs expire after five minutes and are revalidated at the trusted apply/save boundary.

General diagnostics also expose staged DNS/TCP/TLS/HTTP observations. Keep their scope explicit: Windows system sockets can follow the OS routing configuration; they do not prove a native `direct` outbound. Do not label results from one transport as measurements of another.

## Preserve the existing editing flow

On Android, checking a route and browsing the map are substeps of the existing route form. Selecting a checked path changes the draft. There is one **Save route** action in the parent form; Back, cancellation and tapping a map region must not commit settings. Preserve the existing structural-change consent and native acknowledgement rules.

Windows route details already save individual settings. A contextual recommendation uses the existing explicit apply action for that route and waits for the trusted result; it must not create a second route for the checked hostname or change global Auto. Do not introduce another form or a second confirmation flow just to expose purpose metadata. Map markers remain browsing filters on both platforms.

## Fixtures and validation

Use fake service domains such as `fixture.example`, documentation IPs such as `192.0.2.10`, synthetic app/package names and obviously fake credentials. Intercept requests or use a local test server; offline tests must not depend on a public service being available. Synthetic values demonstrate behavior, not real-world connection quality.

Existing tests to extend when the corresponding behavior changes:

- Windows [`connection-quality.check.ts`](../test/connection-quality.check.ts): sample interpretation, metadata compatibility, scoped proof and target suggestions. [`diagnostic-owner.check.ts`](../test/diagnostic-owner.check.ts) covers native selector readback and cancellation ownership.
- Windows [`connection-quality.browser.mjs`](../test/connection-quality.browser.mjs): route context, cancellation, stale results, apply acknowledgement and narrow layouts.
- Android [`ConnectionQualityTest.kt`](../android/app/src/test/java/local/waarp/android/data/ConnectionQualityTest.kt): sample interpretation, proof validity and metadata round trips. [`RoutingCompilerTest.kt`](../android/app/src/test/java/local/waarp/android/data/RoutingCompilerTest.kt) covers destination-rule generation; [`MobileLiveRoutingTest.kt`](../android/app/src/test/java/local/waarp/android/data/MobileLiveRoutingTest.kt) proves purpose metadata does not alter the native routing session.
- Android [`MobileUiInstrumentedTest.kt`](../android/app/src/androidTest/java/local/waarp/android/ui/MobileUiInstrumentedTest.kt), method `atlasAndConnectionCheckKeepTheDraftUntilTheSingleSave`: real route form, local map and one-save behavior. Run device fixtures on a disposable emulator with the repository's Android workflow.

For destination changes, assert the actual generated rule and its scope, including an unrelated destination that must remain unaffected. For evidence changes, cover a healthy current path, insufficient observations, mixed responses, cancellation, expired/changed context and an unrelated route that must remain untouched. A unit test of generated rules does not replace a native device/network test when native behavior changes.

Run the normal Windows checks from the repository root:

```sh
npm run typecheck
npm test
npm run check
npm run build
npm run test:ui
```

With the Android toolchain and pinned core prepared as described in [ANDROID.md](ANDROID.md):

```sh
cd android
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:lintRelease
```

Include the observed commands/results and any unrun device checks in the PR. For a visible change, include screenshots of both affected platforms, including long labels and the existing narrow/font-scale cases. A useful small PR states the service or failure it addresses, the supporting sources, the exact routing/check coverage, and the tests that establish it.
