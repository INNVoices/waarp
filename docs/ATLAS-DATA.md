# Local Atlas data and renderer

Atlas is an alternate view inside the existing server picker and Connections page. It uses the same search,
region/readiness filters, country filter and paginated rows. Choosing a region only filters those rows;
the existing explicit row action remains responsible for selecting a server. Browsing never starts a check,
changes a route or restarts the tunnel. The public catalogue's existing bounded check on entering that
surface remains unchanged.

## Geography and meaning

Both platforms consume `src/shared/atlas-countries.json` and `src/shared/atlas-world.json`.
The outline has 177 land features; the anchor table has 238 regional label points. Small regions missing
from the 1:110m outline use the 1:50m tiny-country label table. The map draws one count marker per known
region, not one marker per server. Unknown regions stay in the selectable list and in a separate count;
they are never drawn at 0°/0°. Group profiles also have no physical location.

Coordinates are Natural Earth's **regional label anchors**, not measured server coordinates or a GeoIP
database. A catalogue source's country tag is only a source claim. Atlas does not derive countries from
latency, IP addresses or device permissions. The existing catalogue may parse a country tag from a
source-provided server label; that tag remains unverified geography. “Your region” is an optional, manually chosen
local presentation preference; leaving it unset keeps the device indicator outside the geographic plane.

The route overlay is a logical link between regional anchors. Solid lines use the core's acknowledged
effective route; dashed lines indicate a pending explicit choice. Neither is a traceroute or a statement
about physical network hops. No line is drawn without both regional anchors. Mere marker selection does
not create a pending or effective route.

## Reproducible source

Source repository: [Natural Earth vector](https://github.com/nvkelso/natural-earth-vector), revision
`ca96624a56bd078437bca8184e78163e5039ad19`.

| Input | Git blob SHA-1 |
|---|---|
| `geojson/ne_110m_admin_0_countries.geojson` | `1e6ab74c7042f97013be69ceec798be8e1aff27d` |
| `geojson/ne_50m_admin_0_tiny_countries.geojson` | `6e476aa6ba350c1cc0d92453d39ca630b6f2283f` |

The generator retains valid `ISO_A2`, or `ISO_A2_EH` when the former is absent, and uses `NAME_EN`,
`LABEL_X`, `LABEL_Y`. The 1:110m input takes precedence for duplicate regions. It rounds coordinates to
three decimal places, removes other metadata, and sorts anchor keys. Non-ISO outline features remain
visible land with a null country and cannot create a marker.

Download those two exact files, then run:

```sh
node scripts/atlas-data.mjs /path/to/ne_110m_admin_0_countries.geojson /path/to/ne_50m_admin_0_tiny_countries.geojson
```

The script verifies each source Git blob before writing, and does not access the network.

| Output | Bytes | SHA-256 |
|---|---:|---|
| `src/shared/atlas-countries.json` | 21,192 | `ae0f3e87983e02285a659088110856a2d6a1e5a318d3d3c17c4e992091808553` |
| `src/shared/atlas-world.json` | 191,212 | `81fd2cf128ec6897f3cf9ddd2bd25079260fe2b152616de5062dc9516588f2a8` |

Natural Earth data is public domain under its [published terms](https://www.naturalearthdata.com/about/terms-of-use/).
The release includes `licenses/NATURAL-EARTH.txt`. Political boundaries are background context from that
pinned dataset, not assertions inferred by Waarp from traffic.

## Windows renderer and privacy boundary

MapLibre GL JS is pinned to **6.19.0** in `package.json` and `package-lock.json`. Its BSD-3-Clause notice and
the complete notices for 25 installed runtime packages are in `licenses/MAPLIBRE-NOTICES.txt`, included as
`resources/licenses/maplibre-gl/THIRD-PARTY-NOTICES.txt`. Natural Earth's notice is included beside it under
`resources/licenses/natural-earth/NOTICE.txt`.

The renderer and its worker are lazy local chunks. The style contains only bundled GeoJSON, local fonts,
fills, circles, symbols and logical lines; it has no raster/vector tile server, sprite server, glyph CDN,
geocoding service, access token or third-party telemetry. An additional request guard rejects external
HTTP origins. CSP allows local workers and the data worker fallback required for an opaque `file:` origin;
it adds no `unsafe-eval` or remote `connect-src`. Reference: [MapLibre v6 migration guide](https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/).

Country aggregates are derived in main from the complete filtered catalogue, then attached to the existing
page response. Endpoint names, hosts and credentials never enter the map's GeoJSON. At most one marker per
known region is rendered; the full node pool remains in main. Catalogue updates coalesce, scroll zoom is
disabled, reduced animation is used, and switching to List removes the map and releases its resources.
An unavailable WebGL renderer leaves the list, search, region control and explicit selection usable.

Tests use synthetic node geography and an injected IPC fixture. They do not validate real network quality,
node ownership or the correctness of a third-party country tag. Native routing and continuity have separate gates.

## Android native notices

The Android application bundles MapLibre Native OpenGL `13.7.1`. Besides its root BSD-2-Clause license,
it includes the complete upstream [`platform/android/LICENSE.md`](https://github.com/maplibre/maplibre-native/blob/4cf121e515d8d065b57cd555a0b231ea27ff0e5d/platform/android/LICENSE.md)
and [`LICENSES.core.md`](https://github.com/maplibre/maplibre-native/blob/4cf121e515d8d065b57cd555a0b231ea27ff0e5d/LICENSES.core.md)
from the exact pinned source, at `assets/licenses/MapLibre-Android-Dependencies.txt` and
`assets/licenses/MapLibre-Core-Dependencies.txt`. The core file also retains the current HarfBuzz notice.
Original upstream files are preserved in full; overlapping notices are intentionally not removed.

The separate gestures `0.0.4` notice is also shipped at `assets/licenses/MapLibre-Gestures.txt`, copied
from [`823df84b427c6f8a320c2f14660f986243f6987b/LICENSE.md`](https://github.com/maplibre/maplibre-gestures-android/blob/823df84b427c6f8a320c2f14660f986243f6987b/LICENSE.md).
It retains the Mapbox/MapLibre copyright and the Android Gesture Detectors Framework notice.

For GeoJSON/Turf `6.0.1`, the published POM declares Apache-2.0, while the corresponding
[`maplibre-java` source tag LICENSE](https://github.com/maplibre/maplibre-java/blob/db35dfd06f9d671bfda1fd5771b478772c872631/LICENSE)
contains the Mapbox MIT notice. Both provided texts are retained: the Android aggregate and
`assets/licenses/MapLibre-Java.txt`. This records the upstream discrepancy without substituting a new license assertion.
