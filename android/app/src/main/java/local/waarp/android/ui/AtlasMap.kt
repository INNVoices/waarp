@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import local.waarp.android.i18n.localized

import android.content.Context
import android.graphics.RectF
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.sources.GeoJsonSource
import java.util.Locale

internal data class AtlasNode(val id: String, val country: String?, val healthy: Boolean)
internal data class AtlasAnchor(val code: String, val name: String, val longitude: Double, val latitude: Double)
private data class AtlasAssets(val anchors: Map<String, AtlasAnchor>, val world: String)
internal const val ATLAS_UNKNOWN = "__unknown__"
// The region keys match the bundled shared Natural Earth derivative; unsupported labels stay in the list.
private val atlasCountryCodes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE ZA ZM ZW".split(' ').toSet()
internal fun atlasCountry(value: String?) = value?.trim()?.uppercase(Locale.ROOT)?.takeIf { it in atlasCountryCodes }.orEmpty()

internal data class AtlasRegionPreference(val country: String, val choose: (String) -> Unit)
internal val LocalAtlasRegion = staticCompositionLocalOf<AtlasRegionPreference> { error("Atlas UI preference is not provided") }

/** Shared by the screen and its forms; a map leaving composition must not erase this UI choice. */
@Composable
internal fun rememberAtlasRegion(): AtlasRegionPreference {
    val context = LocalContext.current.applicationContext
    val preferences = remember(context) { context.getSharedPreferences("waarp-ui", Context.MODE_PRIVATE) }
    var country by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(preferences) {
        val saved = withContext(Dispatchers.IO) {
            runCatching { atlasCountry(preferences.getString("atlas-device-region", null)) }.getOrDefault("")
        }
        // A late disk read must not replace a newer manual choice, including clearing it.
        if (country == null) country = saved
    }
    val choose: (String) -> Unit = remember(preferences) { { value ->
        val next = atlasCountry(value)
        country = next
        // This optional UI preference is independent of routing revisions and VPN intent.
        runCatching {
            preferences.edit().apply {
                if (next.isBlank()) remove("atlas-device-region") else putString("atlas-device-region", next)
            }.apply()
        }
    } }
    return remember(country, choose) { AtlasRegionPreference(country.orEmpty(), choose) }
}

@Composable
internal fun AtlasViewChoice(map: Boolean, onMap: (Boolean) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(!map, onClick = { onMap(false) }, label = { Text(localized("AtlasMap.0c2cddf1db8b", "Список")) }, modifier = Modifier.heightIn(min = 48.dp))
        FilterChip(map, onClick = { onMap(true) }, label = { Text(localized("AtlasMap.b37c79a3043e", "Карта")) }, modifier = Modifier.heightIn(min = 48.dp))
    }
}

/** Local regional overview. It has no network/control-plane dependency and never selects a route. */
@Composable
internal fun AtlasMap(nodes: List<AtlasNode>, country: String, onCountry: (String) -> Unit,
    selectedCountry: String? = null, modifier: Modifier = Modifier, showRegionSelector: Boolean = true) {
    val context = LocalContext.current
    var assets by remember { mutableStateOf<AtlasAssets?>(null) }
    var failure by remember { mutableStateOf(false) }
    val userRegion = LocalAtlasRegion.current
    val userCountry = userRegion.country
    var locationExpanded by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        try {
            assets = withContext(Dispatchers.IO) {
                val source = JSONObject(context.assets.open("atlas/countries.json").bufferedReader().use { it.readText() })
                val anchors = source.keys().asSequence().associateWith { code ->
                    val value = source.getJSONObject(code)
                    AtlasAnchor(code, value.getString("name"), value.getDouble("longitude"), value.getDouble("latitude"))
                }
                AtlasAssets(anchors, context.assets.open("atlas/world.json").bufferedReader().use { it.readText() })
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { failure = true }
    }
    val available = assets
    val grouped = remember(nodes) { nodes.groupBy { atlasCountry(it.country) } }
    val unknown = remember(grouped, available) { grouped.filterKeys { it.isBlank() || available?.anchors?.containsKey(it) == false }.values.sumOf { it.size } }
    val onCountryNow by rememberUpdatedState(onCountry)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(localized("AtlasMap.5dad0c42ecd7", "Узлы сгруппированы по указанной стране. Точка обозначает регион, а не точное местоположение сервера."),
            style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        if (available != null && !failure) {
            val markers = remember(grouped, available) {
                featureCollection(grouped.mapNotNull { (code, members) ->
                    available.anchors[code]?.let { anchor ->
                        pointFeature(anchor, JSONObject().put("country", code).put("count", members.size))
                    }
                })
            }
            val selectedFeatures = remember(country, selectedCountry, userCountry, available) {
                featureCollection(listOfNotNull(
                    available.anchors[country]?.let { pointFeature(it, JSONObject().put("role", "preview")) },
                    available.anchors[atlasCountry(selectedCountry)]?.let { pointFeature(it, JSONObject().put("role", "selected")) },
                    available.anchors[userCountry]?.let { pointFeature(it, JSONObject().put("role", "user")) },
                ))
            }
            val logicalRoute = remember(country, userCountry, available) {
                val from = available.anchors[userCountry]; val to = available.anchors[country]
                featureCollection(if (from == null || to == null || from.code == to.code) emptyList() else listOf(
                    JSONObject().put("type", "Feature").put("properties", JSONObject()).put("geometry", JSONObject()
                        .put("type", "LineString").put("coordinates", JSONArray().put(JSONArray().put(from.longitude).put(from.latitude))
                            .put(JSONArray().put(to.longitude).put(to.latitude))))))
            }
            NativeAtlas(available.world, markers, selectedFeatures, logicalRoute,
                { onCountryNow(it) }, { failure = true }, Modifier.fillMaxWidth().height(260.dp))
            Text(localized("AtlasMap.cab99ff95683", "Natural Earth · локальная карта"), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { locationExpanded = !locationExpanded }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(if (userCountry.isBlank()) localized("AtlasMap.d71a02efc10d", "Указать мой регион") else localized("AtlasMap.0f1a0931bede", "Вы: {arg1}", countryName(userCountry)))
                }
                if (country.isNotBlank()) TextButton(onClick = { onCountry("") }, modifier = Modifier.heightIn(min = 48.dp)) { Text(localized("AtlasMap.f1eff1373d00", "Все регионы")) }
            }
            if (locationExpanded) PathField(localized("AtlasMap.1471dd5eb8e8", "Мой регион · вручную"), userCountry,
                listOf(PathChoice("", localized("AtlasMap.494fb19e25de", "Не указан"), "")) + available.anchors.keys.sortedBy(::countryName).map { PathChoice(it, countryName(it), "") }) {
                userRegion.choose(it); locationExpanded = false
            }
            if (userCountry.isNotBlank() && country in available.anchors) Text(localized("AtlasMap.c7959ea5c480", "Линия показывает выбранное направление. Фактический путь пакетов не измерен."),
                style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            val region = grouped[country]
            if (region != null) Text(localized("AtlasMap.8a567387ab40", "{arg1} · {arg2} узлов · HTTPS-проверку прошли {arg3}", countryName(country), region.size, region.count { it.healthy }),
                style = MaterialTheme.typography.bodySmall)
            // A regular, accessible selector is equivalent to tapping a circle; map gestures are optional.
            if (showRegionSelector) PathField(localized("AtlasMap.1e0259a4ff49", "Показать регион"), country, listOf(PathChoice("", localized("AtlasMap.f1eff1373d00", "Все регионы"), "")) +
                grouped.keys.filter { it in available.anchors }.sortedBy(::countryName).map { PathChoice(it, countryName(it), localized("AtlasMap.86352b001ecd", "{arg1} узлов", grouped[it].orEmpty().size)) } +
                if (unknown > 0) listOf(PathChoice(ATLAS_UNKNOWN, localized("AtlasMap.bfbb3386ccab", "Без географии"), localized("AtlasMap.ff0d2b36ea1e", "{arg1} узлов", unknown))) else emptyList()) { onCountry(it) }
        } else if (failure) {
            InlineMessage(localized("AtlasMap.662fc4b52696", "Карта недоступна на этом устройстве. Подключения доступны в списке ниже."))
            if (country.isNotBlank()) TextButton(onClick = { onCountry("") }) { Text(localized("AtlasMap.349f061ace40", "Показать все подключения")) }
        } else LinearProgressIndicator(Modifier.fillMaxWidth())
        if (unknown > 0) Text(localized("AtlasMap.07d4abb36991", "Без подтверждённого региона: {arg1}. Эти узлы остаются доступны в списке.", unknown),
            style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
    }
}

internal fun countryName(code: String): String = Locale("", code).getDisplayCountry(Locale.getDefault()).takeIf { it.isNotBlank() } ?: code
private fun pointFeature(point: AtlasAnchor, properties: JSONObject) = JSONObject().put("type", "Feature").put("properties", properties)
    .put("geometry", JSONObject().put("type", "Point").put("coordinates", JSONArray().put(point.longitude).put(point.latitude)))
private fun featureCollection(features: List<JSONObject>) = JSONObject().put("type", "FeatureCollection").put("features", JSONArray(features)).toString()

@Composable
private fun NativeAtlas(world: String, markers: String, selected: String, route: String,
    onCountry: (String) -> Unit, onFailure: () -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val countryNow by rememberUpdatedState(onCountry)
    val failureNow by rememberUpdatedState(onFailure)
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var ready by remember { mutableStateOf(false) }
    var rendered by remember { mutableStateOf(false) }
    var alive by remember { mutableStateOf(true) }
    val view = remember(context) {
        runCatching {
            MapLibre.getInstance(context)
            MapView(context, MapLibreMapOptions().textureMode(true)).also { it.onCreate(null) }
        }.getOrNull()
    }
    if (view == null) { LaunchedEffect(Unit) { failureNow() }; return }
    DisposableEffect(view, lifecycle) {
        var started = false; var resumed = false
        fun start() { if (!started) { view.onStart(); started = true } }
        fun resume() { start(); if (!resumed) { view.onResume(); resumed = true } }
        fun pause() { if (resumed) { view.onPause(); resumed = false } }
        fun stop() { pause(); if (started) { view.onStop(); started = false } }
        val observer = LifecycleEventObserver { _, event ->
            when (event) { Lifecycle.Event.ON_START -> start(); Lifecycle.Event.ON_RESUME -> resume()
                Lifecycle.Event.ON_PAUSE -> pause(); Lifecycle.Event.ON_STOP -> stop(); else -> Unit }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) resume()
        else if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) start()
        onDispose { alive = false; lifecycle.removeObserver(observer); stop(); view.onDestroy(); map = null }
    }
    AndroidView(factory = {
        view.addOnDidFailLoadingMapListener { if (alive) failureNow() }
        view.addOnDidFinishRenderingMapListener { fully -> if (alive && ready && fully) rendered = true }
        view.getMapAsync { current ->
            if (alive) {
                map = current
                current.uiSettings.isAttributionEnabled = false
                current.uiSettings.isLogoEnabled = false
                current.uiSettings.isRotateGesturesEnabled = false
                current.uiSettings.isTiltGesturesEnabled = false
                current.cameraPosition = CameraPosition.Builder().target(LatLng(24.0, 12.0)).zoom(0.6).build()
                current.setStyle(Style.Builder().fromJson(ATLAS_STYLE)) { style ->
                    if (alive) {
                        style.getSourceAs<GeoJsonSource>("world")?.setGeoJson(world)
                        ready = true
                    }
                }
                current.addOnMapClickListener { coordinate ->
                    if (!alive || !ready) false else {
                        val point = current.projection.toScreenLocation(coordinate)
                        val item = current.queryRenderedFeatures(RectF(point.x - 16, point.y - 16, point.x + 16, point.y + 16), "regions").firstOrNull()
                        item?.getStringProperty("country")?.let { countryNow(it) }
                        item != null
                    }
                }
            }
        }
        view
    }, modifier = modifier.testTag("waarp-atlas-map").semantics {
        contentDescription = localized("AtlasMap.49c4c68a92aa", "Карта регионов")
        stateDescription = if (rendered) localized("AtlasMap.0cb9ea3fd38f", "Локальная карта загружена") else localized("AtlasMap.7a82e625c9b2", "Загрузка локальной карты")
    }, update = { })
    LaunchedEffect(map, ready, markers, selected, route) {
        if (alive && ready) map?.style?.let { style ->
            style.getSourceAs<GeoJsonSource>("regions")?.setGeoJson(markers)
            style.getSourceAs<GeoJsonSource>("selection")?.setGeoJson(selected)
            style.getSourceAs<GeoJsonSource>("route")?.setGeoJson(route)
        }
    }
}

private val ATLAS_STYLE = """{"version":8,"sources":{
"world":{"type":"geojson","data":{"type":"FeatureCollection","features":[]}},
"regions":{"type":"geojson","data":{"type":"FeatureCollection","features":[]}},
"selection":{"type":"geojson","data":{"type":"FeatureCollection","features":[]}},
"route":{"type":"geojson","data":{"type":"FeatureCollection","features":[]}}},
"layers":[{"id":"background","type":"background","paint":{"background-color":"#151718"}},
{"id":"land","type":"fill","source":"world","paint":{"fill-color":"#303332","fill-outline-color":"#535550"}},
{"id":"direction","type":"line","source":"route","paint":{"line-color":"#f4a35b","line-width":2,"line-dasharray":[3,2]}},
{"id":"regions","type":"circle","source":"regions","paint":{"circle-color":"#eb9b58","circle-opacity":0.85,"circle-radius":["interpolate",["linear"],["get","count"],1,6,100,13,2000,23]}},
{"id":"selection","type":"circle","source":"selection","paint":{"circle-color":["match",["get","role"],"user","#87b9ee","selected","#f4a35b","#ffffff"],"circle-radius":5,"circle-stroke-color":"#151718","circle-stroke-width":2}}]}"""
