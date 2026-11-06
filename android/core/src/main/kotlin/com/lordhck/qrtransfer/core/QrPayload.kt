package com.lordhck.qrtransfer.core

/**
 * Recovers the exact binary payload of a scanned QR code.
 *
 * Scanner libraries disagree on what "raw bytes" means. Some return the
 * decoded payload, some return the QR data codewords (mode indicator,
 * character count, payload, terminator, padding), and the text value may have
 * been pushed through a charset guess. Every plausible interpretation is tried
 * and the first one whose frame CRC-32 verifies wins, so a wrong guess can
 * never produce a bad frame.
 */
object QrPayload {
    private const val MODE_TERMINATOR = 0b0000
    private const val MODE_BYTE = 0b0100
    private const val MODE_ECI = 0b0111

    /** Decode a frame from scanner output, or null if nothing verifies. */
    fun extractFrame(rawBytes: ByteArray?, rawValue: String?): Frame? {
        for (candidate in candidates(rawBytes, rawValue)) {
            try {
                return Protocol.decodeFrame(candidate)
            } catch (_: ProtocolException) {
                // Try the next interpretation.
            }
        }
        return null
    }

    fun candidates(rawBytes: ByteArray?, rawValue: String?): List<ByteArray> {
        val out = ArrayList<ByteArray>(5)
        fun add(bytes: ByteArray?) {
            if (bytes != null && bytes.size >= Protocol.OVERHEAD && out.none { it.contentEquals(bytes) }) out.add(bytes)
        }
        if (rawBytes != null) {
            add(rawBytes)
            // Byte-mode character count is 8 bits for versions 1-9, 16 bits otherwise.
            add(parseCodewords(rawBytes, countBits = 8))
            add(parseCodewords(rawBytes, countBits = 16))
        }
        if (rawValue != null) {
            add(rawValue.toByteArray(Charsets.ISO_8859_1))
            // Undo a Latin-1 -> UTF-8 re-encoding (seen in some decoders).
            add(undoUtf8(rawValue))
        }
        return out
    }

    /**
     * Parse QR data codewords and concatenate all byte-mode segments.
     * Returns null for streams that use other modes or are malformed.
     */
    internal fun parseCodewords(codewords: ByteArray, countBits: Int): ByteArray? {
        val reader = BitReader(codewords)
        val out = java.io.ByteArrayOutputStream(codewords.size)
        while (reader.remaining >= 4) {
            when (reader.read(4)) {
                MODE_TERMINATOR -> break
                MODE_BYTE -> {
                    if (reader.remaining < countBits) return null
                    val count = reader.read(countBits)
                    if (reader.remaining < count * 8) return null
                    repeat(count) { out.write(reader.read(8)) }
                }
                MODE_ECI -> {
                    // Single-byte ECI designator; the payload stays raw bytes.
                    if (reader.remaining < 8 || reader.read(8) and 0x80 != 0) return null
                }
                else -> return null
            }
        }
        return if (out.size() > 0) out.toByteArray() else null
    }

    private fun undoUtf8(value: String): ByteArray? {
        if (value.any { it.code > 0xFF }) return null
        return value.toByteArray(Charsets.ISO_8859_1)
            .toString(Charsets.UTF_8)
            .takeIf { s -> s.all { it.code <= 0xFF } && !s.contains('�') }
            ?.toByteArray(Charsets.ISO_8859_1)
    }

    private class BitReader(private val data: ByteArray) {
        private var position = 0
        val remaining: Int get() = data.size * 8 - position

        fun read(bits: Int): Int {
            var value = 0
            repeat(bits) {
                val byte = data[position ushr 3].toInt()
                value = (value shl 1) or ((byte ushr (7 - (position and 7))) and 1)
                position++
            }
            return value
        }
    }
}
