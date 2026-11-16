package local.waarp.android.ui

const val DIRECT_PATH = "direct"
const val AUTO_PATH = "g-auto"

/** Screen data only. Private keys, passwords and subscription URLs never belong here. */
data class MobileState(
    val initialized: Boolean = false,
    val status: ConnectionUi = ConnectionUi(),
    val profiles: List<TunnelUi> = emptyList(),
    val groups: List<GroupUi> = emptyList(),
    val routes: List<RouteUi> = emptyList(),
    val apps: List<AppUi> = emptyList(),
    val presets: List<PresetUi> = emptyList(),
    val settings: SettingsUi = SettingsUi(),
    val catalog: CatalogUi = CatalogUi(),
    val flows: List<FlowUi> = emptyList(),
    val latencyHistory: List<LatencySeriesUi> = emptyList(),
    val diagnostic: DiagnosticUi? = null,
    val logs: List<LogLineUi> = emptyList(),
    val notices: List<NoticeUi> = emptyList(),
    val error: String? = null,
    val message: UiMessage? = null,
    val appVersion: String = "",
    val engineVersion: String = "",
    val backgroundTask: String? = null,
)

enum class ConnectionPhase { OFF, STARTING, ON, STOPPING, ERROR }
enum class TunnelHealth { UNKNOWN, OK, DEGRADED, DOWN, BUSY }
enum class ProfileSource { PERSONAL, PUBLIC, MANAGED, WARP }
enum class RouteKind { APP, SERVICE, CUSTOM }
enum class RouteState { OK, FALLBACK, RETRYING, CHECK_FAILED, BLOCKED, DIRECT, IDLE, OFF }
enum class GroupPolicy { FASTEST, FIRST }
enum class NoticeLevel { INFO, WARNING, BLOCK }
enum class ObservationResult { OK, FAILED, SKIPPED, UNKNOWN }

data class ConnectionUi(
    val phase: ConnectionPhase = ConnectionPhase.OFF,
    val requestedOpen: Boolean = false,
    val recovering: Boolean = false,
    val recoveryFailed: Boolean = false,
    val error: String? = null,
    val connectedSinceMillis: Long? = null,
    val downloadBytesPerSecond: Long = 0,
    val uploadBytesPerSecond: Long = 0,
    val downloadedBytes: Long = 0,
    val uploadedBytes: Long = 0,
    val selectedPathLabel: String? = null,
    val autoPoolLive: Int? = null,
    val autoPoolTotal: Int? = null,
)

data class TunnelUi(
    val id: String,
    val name: String,
    val protocol: String,
    val host: String = "",
    val port: Int = 0,
    val addresses: List<String> = emptyList(),
    val source: ProfileSource = ProfileSource.PERSONAL,
    val health: TunnelHealth = TunnelHealth.UNKNOWN,
    val latencyMs: Double? = null,
    val country: String? = null,
    val revoked: Boolean = false,
    val subscription: Boolean = false,
    val subscriptionMissing: Boolean = false,
    val clientPublicKey: String? = null,
    val canRename: Boolean = true,
    val canReplace: Boolean = true,
    val canDelete: Boolean = true,
)

data class GroupUi(
    val id: String,
    val name: String,
    val policy: GroupPolicy,
    val members: List<String>,
    val selectedMemberId: String? = null,
    val health: TunnelHealth = TunnelHealth.UNKNOWN,
    val latencyMs: Double? = null,
)

data class RouteUi(
    val id: String,
    val kind: RouteKind,
    val name: String,
    val viaId: String,
    val fallbackViaId: String? = null,
    val enabled: Boolean = true,
    val packageName: String? = null,
    val presetId: String? = null,
    val selector: String? = null,
    val state: RouteState = RouteState.IDLE,
    val effectiveViaId: String? = null,
    val reason: String? = null,
    val downloadedBytes: Long = 0,
    val uploadedBytes: Long = 0,
)

data class AppUi(
    val packageName: String,
    val name: String,
    val uid: Int,
    val system: Boolean = false,
    val versionCode: Long = 0,
)

data class PresetUi(val id: String, val name: String, val description: String, val domains: List<String> = emptyList())

data class SettingsUi(
    val defaultViaId: String = DIRECT_PATH,
    val lastWholeDeviceViaId: String? = null,
    val lanDirect: Boolean = true,
    val ruDirect: Boolean = false,
    val autoConnect: Boolean = false,
    val notifications: Boolean = true,
    val systemAlwaysOn: Boolean? = null,
    val systemLockdown: Boolean? = null,
    val systemDnsViaId: String? = null,
    val systemDnsHint: String? = null,
    val systemDnsBlocked: Boolean = false,
)

data class SettingsPatch(
    val lanDirect: Boolean? = null,
    val ruDirect: Boolean? = null,
    val autoConnect: Boolean? = null,
    val notifications: Boolean? = null,
)

data class CatalogUi(
    val nodes: List<PublicNodeUi> = emptyList(),
    val sources: List<CatalogSourceUi> = emptyList(),
    val busy: Boolean = false,
    val canRefresh: Boolean = true,
    val checked: Int = 0,
    val planned: Int = 0,
    val total: Int = 0,
    val updatedAtMillis: Long? = null,
    val error: String? = null,
)

data class PublicNodeUi(
    val id: String,
    val name: String,
    val protocol: String,
    val host: String,
    val port: Int,
    val country: String = "",
    val sourceLabel: String = "Публичный источник",
    val latencyMs: Double? = null,
    val health: TunnelHealth = TunnelHealth.UNKNOWN,
    val added: Boolean = false,
)

data class CatalogSourceUi(val name: String, val count: Int, val ok: Boolean, val error: String? = null)
data class FlowUi(
    val id: String,
    val appName: String,
    val packageName: String = "",
    val host: String,
    val port: Int,
    val network: String,
    val viaLabel: String,
    val rule: String = "",
    val downloadedBytes: Long = 0,
    val uploadedBytes: Long = 0,
)

data class LogLineUi(val id: Long, val text: String)

data class LatencySeriesUi(val id: String, val name: String, val samplesMs: List<Double?>)
data class DiagnosticLayerUi(val name: String, val result: ObservationResult, val detail: String = "")
data class DiagnosticPathUi(val id: String, val name: String, val latencyMs: Double?, val result: ObservationResult)
data class DiagnosticUi(
    val target: String,
    val running: Boolean = false,
    val layers: List<DiagnosticLayerUi> = emptyList(),
    val paths: List<DiagnosticPathUi> = emptyList(),
    val conclusion: String? = null,
    val suggestedViaId: String? = null,
)

data class NoticeUi(val id: String, val level: NoticeLevel, val title: String, val detail: String = "")
data class UiMessage(val id: Long, val text: String, val error: Boolean = false)
data class UiResult(val ok: Boolean, val message: String? = null)

data class RouteDraft(
    val id: String? = null,
    val kind: RouteKind,
    val name: String,
    val viaId: String,
    val fallbackViaId: String? = null,
    val enabled: Boolean = true,
    val packageName: String? = null,
    val presetId: String? = null,
    val selector: String? = null,
)

data class GroupDraft(val id: String? = null, val name: String, val policy: GroupPolicy, val members: List<String>)
data class WireGuardDraft(val name: String, val address: String, val endpoint: String, val serverPublicKey: String)

/** Backend owns validation, persistence, ordering and VPN consent. UI never simulates a result. */
interface MobileActions {
    fun connect()
    fun disconnect()
    fun requestFileImport(replaceProfileId: String? = null)
    fun requestQrImport()
    fun requestClipboardImport()
    fun openSystemVpnSettings()
    fun shareDiagnostics()
    fun dismissMessage(id: Long)
    suspend fun refresh(): UiResult
    suspend fun refreshApps(): UiResult
    suspend fun setDefaultRoute(viaId: String): UiResult
    suspend fun setSystemDnsPath(viaId: String?): UiResult
    suspend fun saveRoute(route: RouteDraft): UiResult
    suspend fun setRouteEnabled(id: String, enabled: Boolean): UiResult
    suspend fun deleteRoute(id: String): UiResult
    suspend fun importText(text: String, name: String = ""): UiResult
    suspend fun createWireGuard(draft: WireGuardDraft): UiResult
    suspend fun renameTunnel(id: String, name: String): UiResult
    suspend fun replaceTunnel(id: String, text: String): UiResult
    suspend fun removeTunnel(id: String, replacementId: String? = null): UiResult
    suspend fun refreshSubscription(id: String): UiResult
    suspend fun saveGroup(group: GroupDraft): UiResult
    suspend fun deleteGroup(id: String, replacementId: String? = null): UiResult
    suspend fun refreshCatalog(): UiResult
    suspend fun addCatalogNode(id: String): UiResult
    suspend fun addBestPublicGroup(): UiResult
    suspend fun diagnose(target: String): UiResult
    suspend fun probeTunnels(): UiResult
    suspend fun readLogs(): UiResult
    suspend fun recover(): UiResult
    suspend fun saveSettings(patch: SettingsPatch): UiResult
}
