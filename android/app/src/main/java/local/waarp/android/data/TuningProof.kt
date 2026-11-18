// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

/** Measurement is tied to a particular saved profile, physical network and user intent. */
data class TuningProof(val profileId: String, val signature: String, val network: Long, val intent: Long,
    val revision: Long, val checkedAt: Long, val successful: Set<String>) {
    fun current(profile: TunnelProfile?, networkNow: Long?, intentNow: Long, revisionNow: Long, now: Long): Boolean =
        profile != null && !profile.revoked && !profile.subscriptionMissing && profile.id == profileId &&
            ProfileTuning.signature(profile) == signature && networkNow != null && networkNow == network &&
            intentNow == intent && revisionNow == revision && now >= checkedAt && now - checkedAt < ProfileTuning.RESULT_TTL_MS
}
