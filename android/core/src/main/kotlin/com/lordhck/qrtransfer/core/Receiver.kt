package com.lordhck.qrtransfer.core

import java.util.BitSet

/**
 * Collects the frames of one stream and reassembles the ciphertext.
 * Mirrors `Receiver` in app/core/protocol.py. Not thread-safe: feed it from
 * a single thread.
 */
class Receiver(
    private val store: ChunkStore = MemoryChunkStore(),
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
) {
    enum class Event { NEW_CHUNK, MANIFEST, DUPLICATE, REJECTED, IGNORED, NEW_STREAM }

    var streamId: Long? = null
        private set
    var total: Int = 0
        private set
    var chunkSize: Int = 0
        private set
    var manifest: Manifest? = null
        private set
    var received: Int = 0
        private set
    var duplicates: Int = 0
        private set
    var rejected: Int = 0
        private set

    private var have = BitSet()

    val complete: Boolean get() = manifest != null && total > 0 && received == total

    fun has(index: Int): Boolean = have.get(index)

    /** Copy of the received-chunk bitmap (for progress displays). */
    fun receivedSet(): BitSet = have.clone() as BitSet

    fun missing(limit: Int = Int.MAX_VALUE): List<Int> {
        val out = ArrayList<Int>()
        var i = have.nextClearBit(0)
        while (i < total && out.size < limit) {
            out.add(i)
            i = have.nextClearBit(i + 1)
        }
        return out
    }

    fun reset() {
        streamId = null
        total = 0
        chunkSize = 0
        manifest = null
        received = 0
        duplicates = 0
        rejected = 0
        have = BitSet()
    }

    /** Feed raw frame bytes (as scanned). */
    fun feed(data: ByteArray): Event {
        val frame = try {
            Protocol.decodeFrame(data)
        } catch (_: ProtocolException) {
            rejected++
            return Event.REJECTED
        }
        return feed(frame)
    }

    fun feed(frame: Frame): Event {
        if (frame.type != Protocol.TYPE_DATA && frame.type != Protocol.TYPE_MANIFEST) return Event.IGNORED

        var event: Event? = null
        if (streamId != null && frame.streamId != streamId) {
            // The sender restarted the stream (e.g. changed density): start over.
            reset()
            event = Event.NEW_STREAM
        }
        if (frame.total <= 0 || frame.total > Int.MAX_VALUE || (total != 0 && frame.total != total.toLong())) {
            rejected++
            return Event.REJECTED
        }

        val result = if (frame.type == Protocol.TYPE_MANIFEST) acceptManifest(frame) else acceptData(frame)
        return if (event != null && result != Event.REJECTED) event else result
    }

    private fun acceptManifest(frame: Frame): Event {
        if (manifest != null) {
            duplicates++
            return Event.DUPLICATE
        }
        val m = try {
            Protocol.decodeManifest(frame.payload)
        } catch (_: ProtocolException) {
            rejected++
            return Event.REJECTED
        }
        if (m.total != frame.total || (chunkSize != 0 && m.chunkSize != chunkSize)) {
            rejected++
            return Event.REJECTED
        }
        if (!begin(frame, m.chunkSize)) return Event.REJECTED
        manifest = m
        return Event.MANIFEST
    }

    private fun acceptData(frame: Frame): Event {
        val size = frame.payload.size
        if (frame.index >= frame.total || size == 0 || (chunkSize != 0 && size != chunkSize)) {
            rejected++
            return Event.REJECTED
        }
        if (!begin(frame, size)) return Event.REJECTED
        val index = frame.index.toInt()
        if (have.get(index)) {
            duplicates++
            return Event.DUPLICATE
        }
        store.write(index, frame.payload)
        have.set(index)
        received++
        return Event.NEW_CHUNK
    }

    /** Initialise storage on the first accepted frame of a stream. */
    private fun begin(frame: Frame, size: Int): Boolean {
        if (total != 0) return true
        if (frame.total * size > maxBytes) {
            rejected++
            return false
        }
        streamId = frame.streamId
        total = frame.total.toInt()
        chunkSize = size
        store.reset(total, size)
        return true
    }

    /** The verified ciphertext. Throws [ProtocolException] if incomplete or corrupt. */
    fun assemble(): ByteArray {
        val m = manifest ?: throw ProtocolException("transfer incomplete")
        if (!complete) throw ProtocolException("transfer incomplete")
        if (m.ctLength > maxBytes) throw ProtocolException("transfer too large")
        val data = store.read(m.ctLength.toInt())
        if (!Crypto.sha256(data).contentEquals(m.ctSha256)) throw ProtocolException("ciphertext digest mismatch")
        return data
    }

    companion object {
        const val DEFAULT_MAX_BYTES: Long = 256L * 1024 * 1024
    }
}
