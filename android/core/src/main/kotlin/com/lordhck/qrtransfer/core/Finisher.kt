package com.lordhck.qrtransfer.core

import java.security.GeneralSecurityException

/** Decrypted file metadata (see buildMeta in crypto.js). */
class TransferMeta(val name: String, val type: String, val size: Long, val sha256: String) {
    companion object {
        fun parse(json: ByteArray): TransferMeta {
            val obj = MiniJson.parse(json.toString(Charsets.UTF_8)) as? Map<*, *>
                ?: throw JsonException("metadata is not an object")
            if (obj["v"] != 1L) throw JsonException("unsupported metadata version")
            val name = obj["name"] as? String ?: throw JsonException("missing name")
            val type = obj["type"] as? String ?: "application/octet-stream"
            val size = obj["size"] as? Long ?: throw JsonException("missing size")
            val sha = (obj["sha256"] as? String)?.lowercase() ?: throw JsonException("missing sha256")
            if (size < 0 || !sha.matches(Regex("[0-9a-f]{64}"))) throw JsonException("invalid metadata")
            return TransferMeta(name, type, size, sha)
        }
    }
}

class ReceivedFile(val meta: TransferMeta, val data: ByteArray)

/** Why a completed scan could not produce a file. */
class ReceiveException(val reason: Reason, message: String, cause: Throwable? = null) : Exception(message, cause) {
    enum class Reason { INCOMPLETE, TRANSPORT_CORRUPT, PASSWORD_REQUIRED, WRONG_KEY, BAD_METADATA, CHECKSUM }
}

/**
 * Turns a complete [Receiver] into the original file:
 * ciphertext SHA-256 -> metadata AES-GCM -> file AES-GCM -> plaintext SHA-256.
 */
object Finisher {
    fun finish(receiver: Receiver): ReceivedFile {
        val manifest = receiver.manifest
        if (manifest == null || !receiver.complete) {
            throw ReceiveException(ReceiveException.Reason.INCOMPLETE, "Transfer is not complete yet")
        }
        if (manifest.passwordProtected) {
            throw ReceiveException(
                ReceiveException.Reason.PASSWORD_REQUIRED,
                "This transfer is password-protected, which this app version does not support yet",
            )
        }
        val ciphertext = try {
            receiver.assemble()
        } catch (e: ProtocolException) {
            throw ReceiveException(ReceiveException.Reason.TRANSPORT_CORRUPT, "Received data is corrupt (${e.message})", e)
        }
        val meta = try {
            TransferMeta.parse(Crypto.open(manifest.key, manifest.meta, Crypto.META_AAD))
        } catch (e: GeneralSecurityException) {
            throw ReceiveException(ReceiveException.Reason.WRONG_KEY, "Could not decrypt the file information", e)
        } catch (e: JsonException) {
            throw ReceiveException(ReceiveException.Reason.BAD_METADATA, "File information is invalid", e)
        }
        val plaintext = try {
            Crypto.open(manifest.key, ciphertext, Crypto.FILE_AAD)
        } catch (e: GeneralSecurityException) {
            throw ReceiveException(ReceiveException.Reason.WRONG_KEY, "Could not decrypt the file", e)
        }
        if (plaintext.size.toLong() != meta.size || Crypto.hex(Crypto.sha256(plaintext)) != meta.sha256) {
            throw ReceiveException(ReceiveException.Reason.CHECKSUM, "SHA-256 verification failed")
        }
        return ReceivedFile(meta, plaintext)
    }
}

object FileNames {
    private const val MAX_LENGTH = 120
    private const val FALLBACK = "qr-transfer.bin"

    /** A name that is safe to use as a single file name on Android. */
    fun sanitize(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base
            .filter { it >= ' ' && it != '\u007F' && it !in "<>:\"|?*" }
            .trim()
            .trimStart('.')
        if (cleaned.isEmpty()) return FALLBACK
        if (cleaned.length <= MAX_LENGTH) return cleaned
        val dot = cleaned.lastIndexOf('.')
        val ext = if (dot > 0 && cleaned.length - dot <= 10) cleaned.substring(dot) else ""
        return cleaned.take(MAX_LENGTH - ext.length) + ext
    }
}
