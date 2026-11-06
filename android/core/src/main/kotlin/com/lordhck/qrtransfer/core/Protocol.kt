package com.lordhck.qrtransfer.core

import java.nio.ByteBuffer
import java.util.zip.CRC32

/** A frame or manifest could not be decoded. */
class ProtocolException(message: String) : Exception(message)

/**
 * QR transport protocol v1. Mirrors app/core/protocol.py; both are tested
 * against tests/vectors/protocol.json.
 *
 * Frame: u8 ver_type | u32 stream_id | u32 index | u32 total | payload | u32 crc32
 */
object Protocol {
    const val VERSION = 1
    const val TYPE_DATA = 0x0
    const val TYPE_MANIFEST = 0x1
    const val TYPE_REPAIR = 0x2
    const val HEADER_SIZE = 13
    const val OVERHEAD = 17
    const val FLAG_PASSWORD = 0x01
    const val KEY_BYTES = 32
    const val SHA256_BYTES = 32
    const val SALT_BYTES = 16
    const val MAX_U32 = 0xFFFF_FFFFL

    fun crc32(data: ByteArray, offset: Int = 0, length: Int = data.size): Long =
        CRC32().apply { update(data, offset, length) }.value

    fun chunkCount(ctLength: Long, chunkSize: Int): Long {
        if (ctLength <= 0 || chunkSize <= 0) throw ProtocolException("lengths must be positive")
        return (ctLength + chunkSize - 1) / chunkSize
    }

    fun encodeFrame(type: Int, streamId: Long, index: Long, total: Long, payload: ByteArray): ByteArray {
        if (type !in 0..0xF) throw ProtocolException("frame type out of range")
        for (v in longArrayOf(streamId, index, total)) {
            if (v !in 0..MAX_U32) throw ProtocolException("field out of range")
        }
        val buf = ByteBuffer.allocate(OVERHEAD + payload.size)
        buf.put(((VERSION shl 4) or type).toByte())
        buf.putInt(streamId.toInt())
        buf.putInt(index.toInt())
        buf.putInt(total.toInt())
        buf.put(payload)
        buf.putInt(crc32(buf.array(), 0, HEADER_SIZE + payload.size).toInt())
        return buf.array()
    }

    fun decodeFrame(data: ByteArray): Frame {
        if (data.size < OVERHEAD) throw ProtocolException("frame too short")
        val bodyLength = data.size - 4
        val buf = ByteBuffer.wrap(data)
        val crc = buf.getInt(bodyLength).toLong() and MAX_U32
        if (crc32(data, 0, bodyLength) != crc) throw ProtocolException("crc mismatch")
        val verType = data[0].toInt() and 0xFF
        val version = verType ushr 4
        if (version != VERSION) throw ProtocolException("unsupported version $version")
        return Frame(
            version = version,
            type = verType and 0xF,
            streamId = buf.getInt(1).toLong() and MAX_U32,
            index = buf.getInt(5).toLong() and MAX_U32,
            total = buf.getInt(9).toLong() and MAX_U32,
            payload = data.copyOfRange(HEADER_SIZE, bodyLength),
        )
    }

    fun decodeManifest(payload: ByteArray): Manifest {
        val buf = ByteBuffer.wrap(payload)
        fun need(n: Int) {
            if (buf.remaining() < n) throw ProtocolException("manifest truncated")
        }
        fun take(n: Int): ByteArray {
            need(n)
            return ByteArray(n).also { buf.get(it) }
        }
        need(7)
        val flags = buf.get().toInt() and 0xFF
        val chunkSize = buf.getShort().toInt() and 0xFFFF
        val ctLength = buf.getInt().toLong() and MAX_U32
        val ctSha256 = take(SHA256_BYTES)
        val key = take(KEY_BYTES)
        val salt = if (flags and FLAG_PASSWORD != 0) take(SALT_BYTES) else null
        need(2)
        val metaLength = buf.getShort().toInt() and 0xFFFF
        val meta = take(metaLength)
        if (buf.hasRemaining()) throw ProtocolException("trailing bytes after manifest")
        if (chunkSize == 0 || ctLength == 0L) throw ProtocolException("manifest lengths must be positive")
        return Manifest(chunkSize, ctLength, ctSha256, key, meta, salt)
    }
}

class Frame(
    val version: Int,
    val type: Int,
    val streamId: Long,
    val index: Long,
    val total: Long,
    val payload: ByteArray,
)

class Manifest(
    val chunkSize: Int,
    val ctLength: Long,
    val ctSha256: ByteArray,
    val key: ByteArray,
    val meta: ByteArray,
    val salt: ByteArray?,
) {
    val passwordProtected: Boolean get() = salt != null
    val total: Long get() = Protocol.chunkCount(ctLength, chunkSize)
}
