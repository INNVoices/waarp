package local.waarp.android.data

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
class ProfileStore(context: Context) {
    private val file = AtomicFile(File(context.filesDir, "profiles/state.enc"))
    private val mutex = Mutex()
    private fun key(create: Boolean = true): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        check(create) { "Ключ хранилища недоступен" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
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
                    require(output.size() + count <= 16 * 1024 * 1024)
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
            throw IllegalStateException("Не удалось открыть защищённое хранилище. Данные сохранены; повторите попытку после разблокировки устройства.", error)
        }
    }
    suspend fun write(data: AppData) = withContext(Dispatchers.IO) { mutex.withLock {
        data.checked()
        val plain = data.json().toString().toByteArray(Charsets.UTF_8)
        require(plain.size <= 16 * 1024 * 1024) { "Хранилище слишком большое" }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            val encrypted = cipher.doFinal(plain)
            require(cipher.iv.size == 12)
            check(file.baseFile.parentFile?.let { it.isDirectory || it.mkdirs() } == true) { "Не удалось создать хранилище" }
            val stream = file.startWrite()
            try {
                stream.write(byteArrayOf(87, 82, 80, 49)); stream.write(cipher.iv); stream.write(encrypted)
                file.finishWrite(stream)
            } catch (error: Exception) { file.failWrite(stream); throw error }
        } finally { plain.fill(0) }
    } }
    companion object { private const val ALIAS = "waarp-state-aes-v1" }
}
