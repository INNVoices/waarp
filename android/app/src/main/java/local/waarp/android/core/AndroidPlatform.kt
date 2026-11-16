// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.InetAddresses
import android.net.IpPrefix
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.ProxyInfo
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.OsConstants
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NeighborUpdateListener
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.Notification
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.PlatformUser
import io.nekohasekai.libbox.RoutePrefixIterator
import io.nekohasekai.libbox.ShellSession
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import java.io.Closeable
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicReference
import io.nekohasekai.libbox.NetworkInterface as BoxNetworkInterface
import java.net.NetworkInterface as JavaNetworkInterface

/** Android's socket and UID APIs are the only bridge between libbox and the OS. */
internal class AndroidPlatform(
    private val context: Context,
    private val vpn: VpnService?,
    private val current: () -> Boolean,
    private val notification: (Notification) -> Unit,
    private val cancelNotification: (String, Int) -> Unit,
) : PlatformInterface, Closeable {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val monitor = PhysicalNetworkMonitor(connectivity, current)
    private val resolver = AndroidDnsResolver { monitor.network }
    private val tun = AtomicReference<ParcelFileDescriptor?>()
    @Volatile var httpProxyEnabled: Boolean = false
        private set

    val hasTun: Boolean get() = tun.get() != null

    fun start() = monitor.start()

    /** Closing the descriptor is safe even while the native start is unwinding. */
    fun cancelTun() {
        runCatching { tun.getAndSet(null)?.close() }
    }

    override fun close() {
        closeResources(::cancelTun, monitor::close, resolver::close)
    }

    override fun usePlatformAutoDetectInterfaceControl(): Boolean = true

    override fun autoDetectInterfaceControl(fd: Int) {
        if (!current()) throw IOException("Запуск отменён")
        // Headless checks run only while our VPN is OFF, so their sockets cannot loop into it.
        if (vpn != null && !vpn.protect(fd)) throw IOException("Android не разрешил защитить сокет VPN")
    }

    override fun openTun(options: TunOptions): Int {
        val vpn = vpn ?: throw IOException("Проверка профиля не может создавать TUN")
        if (!current()) throw IOException("Запуск отменён")
        check(VpnService.prepare(vpn) == null) { "Разрешение VPN отозвано" }
        val builder = vpn.Builder().setSession("Waarp").setMtu(options.mtu).setMetered(false)
        val addresses4 = options.inet4Address.toPrefixes()
        val addresses6 = options.inet6Address.toPrefixes()
        require(addresses4.isNotEmpty() || addresses6.isNotEmpty()) { "Для TUN не указан адрес" }
        (addresses4 + addresses6).forEach { builder.addAddress(it.first, it.second) }

        if (options.autoRoute) {
            if (options.getDNSMode()?.value != Libbox.DNSModeDisabled) {
                options.getDNSServerAddress().toStrings().forEach(builder::addDnsServer)
            }
            if (Build.VERSION.SDK_INT >= 33) {
                val routes4 = options.inet4RouteAddress.toPrefixes()
                val routes6 = options.inet6RouteAddress.toPrefixes()
                (routes4.ifEmpty { if (addresses4.isNotEmpty()) listOf("0.0.0.0" to 0) else emptyList() } +
                    routes6.ifEmpty { if (addresses6.isNotEmpty()) listOf("::" to 0) else emptyList() })
                    .forEach { builder.addRoute(IpPrefix(InetAddresses.parseNumericAddress(it.first), it.second)) }
                (options.inet4RouteExcludeAddress.toPrefixes() + options.inet6RouteExcludeAddress.toPrefixes())
                    .forEach { builder.excludeRoute(IpPrefix(InetAddresses.parseNumericAddress(it.first), it.second)) }
            } else {
                // libbox has already subtracted exclude ranges for pre-33 Android.
                (options.inet4RouteRange.toPrefixes() + options.inet6RouteRange.toPrefixes())
                    .forEach { builder.addRoute(it.first, it.second) }
            }
        }

        val included = options.includePackage.toStrings().distinct()
        val excluded = options.excludePackage.toStrings().distinct()
        require(included.isEmpty() || excluded.isEmpty()) { "Нельзя смешивать include_package и exclude_package" }
        // The mixed/system TCP forwarder listens on the TUN address. Its replies
        // belong to our UID and must return through TUN for the reverse NAT.
        // Excluding our package leaves TCP SYNs pending although UDP still works.
        // Real outbound sockets bypass VPN individually through protect(fd).
        if (included.isNotEmpty()) {
            require(included.any { it != vpn.packageName }) { "В список VPN не добавлены приложения" }
            // A vanished package is an explicit config error, never an accidental allow-all.
            (included + vpn.packageName).distinct().forEach(builder::addAllowedApplication)
        } else {
            excluded.filter { it != vpn.packageName }.forEach(builder::addDisallowedApplication)
        }

        httpProxyEnabled = options.isHTTPProxyEnabled
        if (httpProxyEnabled) {
            builder.setHttpProxy(ProxyInfo.buildDirectProxy(
                options.getHTTPProxyServer(), options.getHTTPProxyServerPort(),
                options.getHTTPProxyBypassDomain().toStrings(),
            ))
        }
        if (!current()) throw IOException("Запуск отменён")
        val descriptor = builder.establish() ?: throw IOException("Android не создал VPN: разрешение отсутствует или отозвано")
        if (!current()) {
            descriptor.close()
            throw IOException("Запуск отменён")
        }
        tun.getAndSet(descriptor)?.close()
        // Keep ownership until CloseService has released the native TUN.
        return descriptor.fd
    }

    override fun findConnectionOwner(
        ipProtocol: Int, sourceAddress: String, sourcePort: Int,
        destinationAddress: String, destinationPort: Int,
    ): ConnectionOwner {
        val owner = ConnectionOwner().apply { userId = Process.INVALID_UID }
        if (ipProtocol != OsConstants.IPPROTO_TCP && ipProtocol != OsConstants.IPPROTO_UDP) return owner
        return runCatching {
            val uid = connectivity.getConnectionOwnerUid(
                ipProtocol,
                InetSocketAddress(InetAddresses.parseNumericAddress(sourceAddress), sourcePort),
                InetSocketAddress(InetAddresses.parseNumericAddress(destinationAddress), destinationPort),
            )
            if (uid != Process.INVALID_UID) {
                val packages = context.packageManager.getPackagesForUid(uid)?.toList().orEmpty()
                owner.userId = uid
                owner.userName = packages.firstOrNull().orEmpty()
                owner.setAndroidPackageNames(BoxStrings(packages))
            }
            owner
        }.getOrDefault(owner)
    }

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) = monitor.attach(listener)
    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) = monitor.detach(listener)
    override fun localDNSTransport(): LocalDNSTransport = resolver

    override fun getInterfaces(): NetworkInterfaceIterator {
        val result = mutableListOf<BoxNetworkInterface>()
        for (snapshot in monitor.snapshots()) {
            runCatching {
                val link = snapshot.link
                val caps = snapshot.capabilities
                val name = link.interfaceName ?: return@runCatching
                val native = JavaNetworkInterface.getByName(name) ?: return@runCatching
                result += BoxNetworkInterface().apply {
                    index = native.index
                    this.name = native.name
                    mtu = native.mtu
                    addresses = BoxStrings(link.addresses)
                    setDNSServer(BoxStrings(link.dnsServers))
                    gateway = BoxStrings(link.gateways)
                    metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                    type = when {
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Libbox.InterfaceTypeWIFI
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Libbox.InterfaceTypeCellular
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Libbox.InterfaceTypeEthernet
                        else -> Libbox.InterfaceTypeOther
                    }
                    flags = (if (native.isUp) OsConstants.IFF_UP or OsConstants.IFF_RUNNING else 0) or
                        (if (native.isLoopback) OsConstants.IFF_LOOPBACK else 0) or
                        (if (native.isPointToPoint) OsConstants.IFF_POINTOPOINT else 0) or
                        (if (native.supportsMulticast()) OsConstants.IFF_MULTICAST else 0)
                }
            }
        }
        val iterator = result.iterator()
        return object : NetworkInterfaceIterator {
            override fun hasNext(): Boolean = iterator.hasNext()
            override fun next(): BoxNetworkInterface = if (iterator.hasNext()) iterator.next() else BoxNetworkInterface()
        }
    }

    override fun underNetworkExtension(): Boolean = false
    override fun includeAllNetworks(): Boolean = false
    override fun readWIFIState(): WIFIState? = null // SSID rules aren't offered without location permission.
    override fun clearDNSCache() = Unit
    override fun sendNotification(notification: Notification) = this.notification(notification)
    override fun cancelNotification(identifier: String, typeID: Int) = cancelNotification.invoke(identifier, typeID)
    override fun registerMyInterface(name: String) = Unit
    override fun startNeighborMonitor(listener: NeighborUpdateListener) = Unit
    override fun closeNeighborMonitor(listener: NeighborUpdateListener) = Unit
    override fun usePlatformShell(): Boolean = false
    override fun checkPlatformShell(): Unit = throw UnsupportedOperationException("Android shell service is not enabled")
    override fun lookupUser(username: String): PlatformUser = throw UnsupportedOperationException("Android shell service is not enabled")
    override fun lookupSFTPServer(): String = throw UnsupportedOperationException("Android SFTP service is not enabled")
    override fun readSystemSSHHostKey(): String = throw UnsupportedOperationException("Android SSH service is not enabled")
    override fun openShellSession(user: PlatformUser, command: String, environ: StringIterator, term: String, rows: Int, cols: Int): ShellSession =
        throw UnsupportedOperationException("Android shell service is not enabled")
    override fun tailscaleHostname(): String = "waarp-android"
    override fun usePlatformBridge(): Boolean = false
    override fun createBridge(options: BridgeOptions): BridgeSession = throw UnsupportedOperationException("Android bridge service is not enabled")
}

internal class BoxStrings(values: Collection<String>) : StringIterator {
    private val values = values.toList()
    private var position = 0
    override fun len(): Int = values.size - position
    override fun hasNext(): Boolean = position < values.size
    override fun next(): String = if (hasNext()) values[position++] else ""
}

internal fun StringIterator?.toStrings(limit: Int = 4096): List<String> {
    if (this == null) return emptyList()
    val result = ArrayList<String>()
    while (result.size < limit && hasNext()) result += next()
    return result
}

private fun RoutePrefixIterator.toPrefixes(): List<Pair<String, Int>> {
    val result = mutableListOf<Pair<String, Int>>()
    while (hasNext()) next().let { result += it.address() to it.prefix() }
    return result
}

/** Never report our own VPN as the physical network (that would recurse DNS into TUN). */
private class PhysicalNetworkMonitor(
    private val connectivity: ConnectivityManager,
    private val current: () -> Boolean,
) : Closeable {
    data class Snapshot(val network: Network, val capabilities: NetworkCapabilities, val link: LinkSnapshot)
    // LinkProperties has no public copy constructor. Copy only public values
    // into our own snapshot instead of retaining the callback's mutable object.
    data class LinkSnapshot(
        val interfaceName: String?, val addresses: List<String>, val dnsServers: List<String>,
        val gateways: List<String>, val mtu: Int,
    ) {
        companion object {
            fun from(properties: LinkProperties) = LinkSnapshot(
                properties.interfaceName,
                properties.linkAddresses.map { "${it.address.hostAddress}/${it.prefixLength}" },
                properties.dnsServers.mapNotNull { it.hostAddress },
                properties.routes.filter { it.hasGateway() }.mapNotNull { it.gateway?.hostAddress }.distinct(),
                properties.mtu,
            )
        }
    }
    private data class Record(var capabilities: NetworkCapabilities? = null, var link: LinkSnapshot? = null, var blocked: Boolean = false)
    private data class InterfaceState(
        val network: Network, val name: String, val index: Int, val addresses: List<String>,
        val dns: List<String>, val mtu: Int, val metered: Boolean,
    )

    private val thread = HandlerThread("waarp-network")
    private lateinit var handler: Handler
    private val stateLock = Any()
    // libbox can call getInterfaces from another Go thread while updating the
    // default interface. Never hold stateLock across that JNI call.
    private val notificationLock = Any()
    private val records = linkedMapOf<Network, Record>()
    @Volatile private var selected: Snapshot? = null
    val network: Network? get() = selected?.network
    @Volatile private var listener: InterfaceUpdateListener? = null
    @Volatile private var closed = false
    private var registered = false
    private var lastNotified: InterfaceState? = null
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = update { records.getOrPut(network) { Record() } }
        override fun onLost(network: Network) = update { records.remove(network) }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = update {
            records[network]?.capabilities = NetworkCapabilities(caps)
        }
        override fun onLinkPropertiesChanged(network: Network, link: LinkProperties) = update {
            records[network]?.link = LinkSnapshot.from(link)
        }
        override fun onBlockedStatusChanged(network: Network, blocked: Boolean) = update {
            records[network]?.blocked = blocked
        }
    }

    fun start() {
        thread.start()
        handler = Handler(thread.looper)
        synchronized(stateLock) {
            // Register before taking the one initial snapshot. Callbacks wait for
            // the seed and then apply in order, so a loss cannot be missed here.
            connectivity.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), callback, handler,
            )
            registered = true
            for (candidate in connectivity.allNetworks) {
                runCatching {
                    val caps = connectivity.getNetworkCapabilities(candidate) ?: return@runCatching
                    val link = connectivity.getLinkProperties(candidate) ?: return@runCatching
                    if (physical(caps)) records[candidate] = Record(NetworkCapabilities(caps), LinkSnapshot.from(link))
                }
            }
            selectNetwork()
        }
    }

    private fun physical(caps: NetworkCapabilities): Boolean =
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)

    fun snapshots(): List<Snapshot> = synchronized(stateLock) {
        records.mapNotNull { (candidate, record) ->
            val caps = record.capabilities ?: return@mapNotNull null
            val link = record.link ?: return@mapNotNull null
            if (record.blocked || !physical(caps) || link.interfaceName.isNullOrBlank()) null
            else Snapshot(candidate, caps, link)
        }
    }

    private fun selectNetwork() {
        val previous = selected?.network
        selected = snapshots().maxWithOrNull(compareBy<Snapshot> {
            val caps = it.capabilities
            (if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) 4 else 0) +
                (if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) 2 else 0) +
                (if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) 3 else 0)
        }.thenBy { if (it.network == previous) 1 else 0 })
    }

    private fun update(change: () -> Unit) {
        synchronized(stateLock) {
            if (closed) return
            // NetworkCallback arguments are authoritative. Synchronous
            // ConnectivityManager getters here can return older or null state.
            change()
            selectNetwork()
        }
        runCatching { notifyListener() }.onFailure { invalidateListener() }
    }

    private fun notifyListener(force: Boolean = false) = synchronized(notificationLock) {
        if (closed || !current()) return@synchronized
        val target = listener ?: return@synchronized
        val snapshot = selected
        val name = snapshot?.link?.interfaceName
        val native = name?.let(JavaNetworkInterface::getByName)
        val state = if (snapshot == null || name == null || native == null) null else InterfaceState(
            snapshot.network, name, native.index,
            snapshot.link.addresses.sorted(),
            snapshot.link.dnsServers, snapshot.link.mtu,
            !snapshot.capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
        )
        val previous = lastNotified
        if (!force && state == previous) return@synchronized
        if (state == null) target.updateDefaultInterface("", -1, false, false)
        else {
            // The pinned native monitor compares only interface name/index/DNS.
            // A new Android Network or lost local address on the same wlan0 also
            // invalidates old bound sockets, and must produce a native handover.
            if (previous != null && previous.name == state.name && previous.index == state.index &&
                (previous.network != state.network || previous.addresses.any { it !in state.addresses })) {
                target.updateDefaultInterface("", -1, false, false)
            }
            target.updateDefaultInterface(state.name, state.index, state.metered, false)
        }
        lastNotified = state
    }

    private fun invalidateListener() = synchronized(notificationLock) {
        lastNotified = null
        if (!closed && current()) runCatching { listener?.updateDefaultInterface("", -1, false, false) }
        Unit
    }

    fun attach(value: InterfaceUpdateListener) {
        listener = value
        // libbox needs the initial interface synchronously while starting.
        runCatching { notifyListener(force = true) }.onFailure { invalidateListener() }
    }

    fun detach(value: InterfaceUpdateListener) {
        if (listener === value) listener = null
    }

    override fun close() {
        closed = true
        listener = null
        if (registered) runCatching { connectivity.unregisterNetworkCallback(callback) }
        registered = false
        synchronized(stateLock) { records.clear(); selected = null }
        thread.quitSafely()
    }
}
