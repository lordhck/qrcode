package com.lordhck.qrtransfer.core

import java.security.GeneralSecurityException
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM blobs: nonce(12) || ciphertext || tag(16). Matches crypto.js. */
object Crypto {
    const val NONCE_BYTES = 12
    const val TAG_BITS = 128
    val FILE_AAD: ByteArray = "qrt1-file".toByteArray(Charsets.US_ASCII)
    val META_AAD: ByteArray = "qrt1-meta".toByteArray(Charsets.US_ASCII)

    /** Decrypt and authenticate. Throws [GeneralSecurityException] on wrong key or tampering. */
    fun open(key: ByteArray, blob: ByteArray, aad: ByteArray): ByteArray {
        if (key.size != Protocol.KEY_BYTES) throw GeneralSecurityException("invalid key length")
        if (blob.size < NONCE_BYTES + TAG_BITS / 8) throw GeneralSecurityException("ciphertext too short")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_BITS, blob, 0, NONCE_BYTES),
        )
        cipher.updateAAD(aad)
        return cipher.doFinal(blob, NONCE_BYTES, blob.size - NONCE_BYTES)
    }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
