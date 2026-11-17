// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import kotlinx.coroutines.asCoroutineDispatcher
import java.util.concurrent.Executors

/** All users share libbox's global socket/directories; two cores must never overlap. */
internal object NativeLane {
    val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "waarp-native").apply { isDaemon = true } }
    val dispatcher = executor.asCoroutineDispatcher()
}
