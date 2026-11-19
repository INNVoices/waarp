package local.waarp.android.data

import local.waarp.android.i18n.localized

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One encrypted, atomic application state file; device-bound keys are excluded from backups.
 * The native engine's temporary snapshot is separately removed by LibboxRuntime. */
class ProfileStore(context: Context, catalogCache: Boolean = false) {
    private val file = AtomicFile(File(context.filesDir, if (catalogCache) "profiles/catalog.enc" else "profiles/state.enc"))
    private val mutex = Mutex()
    private fun key(create: Boolean = true): SecretKey = synchronized(keyLock) {
        // State and catalogue use separate files/mutexes but one Keystore alias.
        // Serialize lookup + generation across instances so a fresh-install race
        // cannot replace the key that encrypted the other file moments earlier.
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return@synchronized it }
        check(create) { localized("ProfileStore.598e99a71c3b", "Ключ хранилища недоступен") }
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
            generateKey()
        }
    }
    suspend fun read(): AppData = withContext(Dispatchers.IO) { mutex.withLock { readLocked() } }
    private fun readLocked(): AppData {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return AppData()
        try {
            val bytes = file.openRead().use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    require(output.size() + count <= MAX_STORE_BYTES)
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            require(bytes.size > 32 && bytes.copyOfRange(0, 4).contentEquals(byteArrayOf(87, 82, 80, 49)))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, bytes.copyOfRange(4, 16)))
            val plain = cipher.doFinal(bytes, 16, bytes.size - 16)
            return try { AppData.fromJson(JSONObject(plain.toString(Charsets.UTF_8))) } finally { plain.fill(0) }
        } catch (error: Exception) {
            // Preserve the damaged/encrypted file; an unavailable key never silently resets profiles.
            throw IllegalStateException(localized("ProfileStore.e2829d9797b5", "Не удалось открыть защищённое хранилище. Данные сохранены; повторите попытку после разблокировки устройства."), error)
        }
    }
    suspend fun write(data: AppData) = withContext(Dispatchers.IO) { mutex.withLock {
        data.checked()
        val plain = data.json().toString().toByteArray(Charsets.UTF_8)
        try {
            // Header (4), nonce (12) and GCM tag (16) are part of the read limit.
            require(plain.size <= MAX_STORE_BYTES - 32) { localized("ProfileStore.8fc81348dc43", "Хранилище слишком большое") }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            val encrypted = cipher.doFinal(plain)
            require(cipher.iv.size == 12)
            // The independently locked state/catalog files can create this shared
            // directory concurrently on first install; mkdirs=false can mean success
            // by the other writer, so inspect the resulting directory once more.
            check(file.baseFile.parentFile?.let { it.isDirectory || it.mkdirs() || it.isDirectory } == true) { localized("ProfileStore.ada967b89d1f", "Не удалось создать хранилище") }
            val stream = file.startWrite()
            try {
                stream.write(byteArrayOf(87, 82, 80, 49)); stream.write(cipher.iv); stream.write(encrypted)
                file.finishWrite(stream)
            } catch (error: Exception) { file.failWrite(stream); throw error }
        } finally { plain.fill(0) }
    } }
    companion object {
        private val keyLock = Any()
        private const val ALIAS = "waarp-state-aes-v1"
        private const val MAX_STORE_BYTES = 16 * 1024 * 1024
    }
}
