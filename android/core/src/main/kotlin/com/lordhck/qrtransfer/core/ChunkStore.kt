package com.lordhck.qrtransfer.core

import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile

/** Fixed-size chunk storage used by [Receiver]. */
interface ChunkStore : Closeable {
    /** Discard everything and prepare for [total] chunks of [chunkSize] bytes. */
    fun reset(total: Int, chunkSize: Int)

    fun write(index: Int, data: ByteArray)

    /** The first [length] bytes of all chunks concatenated in order. */
    fun read(length: Int): ByteArray
}

class MemoryChunkStore : ChunkStore {
    private var buffer = ByteArray(0)
    private var chunkSize = 0

    override fun reset(total: Int, chunkSize: Int) {
        buffer = ByteArray(Math.multiplyExact(total, chunkSize))
        this.chunkSize = chunkSize
    }

    override fun write(index: Int, data: ByteArray) {
        System.arraycopy(data, 0, buffer, index * chunkSize, data.size)
    }

    override fun read(length: Int): ByteArray = buffer.copyOf(length)

    override fun close() {
        buffer = ByteArray(0)
    }
}

/** Disk-backed store so a long scan does not hold the ciphertext in memory. */
class FileChunkStore(private val file: File) : ChunkStore {
    private var raf: RandomAccessFile? = null
    private var chunkSize = 0

    override fun reset(total: Int, chunkSize: Int) {
        close()
        file.delete()
        this.chunkSize = chunkSize
        raf = RandomAccessFile(file, "rw").apply { setLength(total.toLong() * chunkSize) }
    }

    override fun write(index: Int, data: ByteArray) {
        val f = checkNotNull(raf) { "store not initialised" }
        f.seek(index.toLong() * chunkSize)
        f.write(data)
    }

    override fun read(length: Int): ByteArray {
        val f = checkNotNull(raf) { "store not initialised" }
        val out = ByteArray(length)
        f.seek(0)
        f.readFully(out)
        return out
    }

    override fun close() {
        raf?.close()
        raf = null
    }

    fun delete() {
        close()
        file.delete()
    }
}
