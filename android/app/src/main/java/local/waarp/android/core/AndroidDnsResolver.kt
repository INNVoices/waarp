// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.net.DnsResolver
import android.net.Network
import android.os.CancellationSignal
import io.nekohasekai.libbox.ExchangeContext
import io.nekohasekai.libbox.LocalDNSTransport
import java.io.Closeable
import java.net.InetAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Native DNS goes through the selected physical Network, including after Wi-Fi/LTE changes. */
internal class AndroidDnsResolver(private val physicalNetwork: () -> Network?) : LocalDNSTransport, Closeable {
    private val executor = Executors.newFixedThreadPool(2) { task -> Thread(task, "waarp-dns").apply { isDaemon = true } }
    private val pending = ConcurrentHashMap<CompletableFuture<*>, CancellationSignal>()
    @Volatile private var closed = false

    override fun raw(): Boolean = true

    override fun exchange(ctx: ExchangeContext, message: ByteArray) {
        val network = physicalNetwork()
        if (network == null || closed) { ctx.errorCode(2); return }
        val answer = query<ByteArray>(ctx) { signal, callback ->
            DnsResolver.getInstance().rawQuery(network, message, DnsResolver.FLAG_NO_RETRY, executor, signal, callback)
        }
        if (answer == null) ctx.errorCode(2)
        else if (answer.code != 0) ctx.errorCode(answer.code)
        else ctx.rawSuccess(answer.value)
    }

    override fun lookup(ctx: ExchangeContext, network: String, domain: String) {
        val selected = physicalNetwork()
        if (selected == null || closed) { ctx.errorCode(2); return }
        val answer = query<Collection<InetAddress>>(ctx) { signal, callback ->
            val type = when {
                network.endsWith("4") -> DnsResolver.TYPE_A
                network.endsWith("6") -> DnsResolver.TYPE_AAAA
                else -> null
            }
            if (type == null) DnsResolver.getInstance().query(selected, domain, DnsResolver.FLAG_NO_RETRY, executor, signal, callback)
            else DnsResolver.getInstance().query(selected, domain, type, DnsResolver.FLAG_NO_RETRY, executor, signal, callback)
        }
        if (answer == null) ctx.errorCode(2)
        else if (answer.code != 0) ctx.errorCode(answer.code)
        else ctx.success(answer.value.mapNotNull { it.hostAddress }.joinToString("\n"))
    }

    private data class Answer<T>(val value: T, val code: Int)

    private fun <T : Any> query(ctx: ExchangeContext, start: (CancellationSignal, DnsResolver.Callback<T>) -> Unit): Answer<T>? {
        val future = CompletableFuture<Answer<T>>()
        val signal = CancellationSignal()
        pending[future] = signal
        return try {
            ctx.onCancel { signal.cancel(); future.cancel(false) }
            start(signal, object : DnsResolver.Callback<T> {
                override fun onAnswer(answer: T, rcode: Int) { future.complete(Answer(answer, rcode)) }
                override fun onError(error: DnsResolver.DnsException) { future.completeExceptionally(error) }
            })
            // A cancellation can suppress Android's callback: never leave a Go goroutine waiting forever.
            future.get(15, TimeUnit.SECONDS)
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        } catch (_: Exception) {
            null
        } finally {
            pending.remove(future)
            signal.cancel()
            future.cancel(false)
        }
    }

    override fun close() {
        closed = true
        pending.forEach { (future, signal) -> signal.cancel(); future.cancel(false) }
        pending.clear()
        executor.shutdownNow()
    }
}
