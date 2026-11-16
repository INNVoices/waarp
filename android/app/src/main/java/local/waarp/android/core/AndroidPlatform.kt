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
    private val monitor = PhysicalNetworkMonitor(connectivity)
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
        if (included.isNotEmpty()) {
            val selected = included.filter { it != vpn.packageName }
            require(selected.isNotEmpty()) { "В список VPN не добавлены приложения" }
            // A vanished package is an explicit config error, never an accidental allow-all.
            selected.forEach(builder::addAllowedApplication)
        } else {
            (excluded + vpn.packageName).distinct().forEach(builder::addDisallowedApplication)
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
        for (network in connectivity.allNetworks) {
            runCatching {
                val link = connectivity.getLinkProperties(network) ?: return@runCatching
                val caps = connectivity.getNetworkCapabilities(network) ?: return@runCatching
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@runCatching
                val name = link.interfaceName ?: return@runCatching
                val native = JavaNetworkInterface.getByName(name) ?: return@runCatching
                result += BoxNetworkInterface().apply {
                    index = native.index
                    this.name = native.name
                    mtu = native.mtu
                    addresses = BoxStrings(link.linkAddresses.map { "${it.address.hostAddress}/${it.prefixLength}" })
                    setDNSServer(BoxStrings(link.dnsServers.mapNotNull { it.hostAddress }))
                    gateway = BoxStrings(link.routes.filter { it.hasGateway() }.mapNotNull { it.gateway?.hostAddress }.distinct())
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
private class PhysicalNetworkMonitor(private val connectivity: ConnectivityManager) : Closeable {
    private val thread = HandlerThread("waarp-network")
    private lateinit var handler: Handler
    @Volatile var network: Network? = null
        private set
    @Volatile private var listener: InterfaceUpdateListener? = null
    @Volatile private var closed = false
    private var registered = false
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refresh()
        override fun onLost(network: Network) = refresh()
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refresh()
        override fun onLinkPropertiesChanged(network: Network, link: LinkProperties) = refresh()
    }

    fun start() {
        thread.start()
        handler = Handler(thread.looper)
        refresh()
        connectivity.registerNetworkCallback(
            NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), callback, handler,
        )
        registered = true
    }

    private fun physical(candidate: Network?): Boolean = candidate != null &&
        connectivity.getNetworkCapabilities(candidate)?.let {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        } == true

    private fun refresh() {
        if (closed) return
        runCatching {
            val active = connectivity.activeNetwork?.takeIf(::physical)
            network = active ?: connectivity.allNetworks.filter(::physical).maxByOrNull {
                val caps = connectivity.getNetworkCapabilities(it)
                (if (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true) 4 else 0) +
                    (if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) 2 else 0) +
                    (if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true) 3 else 0)
            }
            notifyListener()
        }.onFailure {
            network = null
            runCatching { listener?.updateDefaultInterface("", -1, false, false) }
        }
    }

    private fun notifyListener() {
        val target = listener ?: return
        val current = network
        val link = current?.let(connectivity::getLinkProperties)
        val name = link?.interfaceName
        val native = name?.let(JavaNetworkInterface::getByName)
        if (name == null || native == null) target.updateDefaultInterface("", -1, false, false)
        else target.updateDefaultInterface(name, native.index,
            connectivity.getNetworkCapabilities(current)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false, false)
    }

    fun attach(value: InterfaceUpdateListener) {
        listener = value
        // libbox needs the initial interface synchronously while starting.
        runCatching { notifyListener() }.onFailure { runCatching { value.updateDefaultInterface("", -1, false, false) } }
    }

    fun detach(value: InterfaceUpdateListener) {
        if (listener === value) listener = null
    }

    override fun close() {
        closed = true
        listener = null
        if (registered) runCatching { connectivity.unregisterNetworkCallback(callback) }
        registered = false
        network = null
        thread.quitSafely()
    }
}
