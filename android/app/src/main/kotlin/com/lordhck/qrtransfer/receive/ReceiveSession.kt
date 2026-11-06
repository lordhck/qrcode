package com.lordhck.qrtransfer.receive

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.lordhck.qrtransfer.core.Crypto
import com.lordhck.qrtransfer.core.FileChunkStore
import com.lordhck.qrtransfer.core.Finisher
import com.lordhck.qrtransfer.core.Frame
import com.lordhck.qrtransfer.core.ReceiveException
import com.lordhck.qrtransfer.core.Receiver
import com.lordhck.qrtransfer.core.TransferMeta
import java.io.File
import java.io.IOException
import java.util.ArrayDeque
import java.util.BitSet
import java.util.concurrent.Executor
import kotlin.math.max

/** Immutable progress snapshot for the UI. */
data class Progress(
    val total: Int,
    val received: Int,
    val hasManifest: Boolean,
    val fileName: String?,
    val fileSize: Long?,
    val duplicates: Int,
    val framesPerSecond: Double,
    val map: BitSet,
    val complete: Boolean,
    val streamRestarted: Boolean,
    /** Milliseconds since the first frame of this stream, or 0 before it. */
    val elapsedMs: Long,
    /** Rough estimate of the remaining time, or null while there is too little data. */
    val etaMs: Long?,
)

sealed interface Outcome {
    data class Saved(val name: String, val size: Long, val mimeType: String, val uri: Uri) : Outcome
    data class Failed(val message: String) : Outcome
}

/**
 * Owns the [Receiver]. Every method that touches it runs on [executor]
 * (a single thread); UI callbacks are posted to the main thread.
 */
class ReceiveSession(
    private val context: Context,
    private val executor: Executor,
    private val onProgress: (Progress) -> Unit,
) {
    private val store = FileChunkStore(File(context.cacheDir, "incoming.chunks"))
    private val receiver = Receiver(store)
    private val main = Handler(Looper.getMainLooper())

    private var meta: TransferMeta? = null
    private var restarted = false
    private var lastPublish = 0L
    private var startedAt = 0L
    private val recentFrames = ArrayDeque<Long>()

    /** Executor thread. */
    fun onFrame(frame: Frame) {
        val event = receiver.feed(frame)
        if (startedAt == 0L && receiver.total > 0) startedAt = SystemClock.uptimeMillis()
        recordFrame()
        when (event) {
            Receiver.Event.NEW_STREAM -> {
                meta = null
                restarted = true
                startedAt = SystemClock.uptimeMillis()
            }
            Receiver.Event.MANIFEST -> readMetaEarly()
            else -> Unit
        }
        if (receiver.manifest != null && meta == null) readMetaEarly()
        publish(force = event == Receiver.Event.MANIFEST || event == Receiver.Event.NEW_STREAM || receiver.complete)
    }

    /** Executor thread: a QR code was read but was not one of our frames. */
    fun onUnreadable() {
        recordFrame()
        publish(force = false)
    }

    fun reset() = executor.execute {
        receiver.reset()
        store.delete()
        meta = null
        restarted = false
        startedAt = 0L
        recentFrames.clear()
        publish(force = true)
    }

    /** Decrypt, verify and save; the result is delivered on the main thread. */
    fun finish(onDone: (Outcome) -> Unit) = executor.execute {
        val outcome = try {
            val file = Finisher.finish(receiver)
            val uri = Saver.save(context, file)
            Outcome.Saved(file.meta.name, file.meta.size, Saver.mimeType(file.meta.type), uri)
        } catch (e: ReceiveException) {
            Outcome.Failed(e.message ?: "Verification failed")
        } catch (e: IOException) {
            Outcome.Failed("Could not save the file: ${e.message}")
        } catch (e: SecurityException) {
            Outcome.Failed("Could not save the file: ${e.message}")
        } finally {
            // The chunk file only holds ciphertext, but there is no reason to keep it.
            store.delete()
        }
        main.post { onDone(outcome) }
    }

    fun close() = executor.execute { store.delete() }

    /** The file name is encrypted inside the manifest; show it as soon as possible. */
    private fun readMetaEarly() {
        val m = receiver.manifest ?: return
        if (m.passwordProtected) return
        meta = try {
            TransferMeta.parse(Crypto.open(m.key, m.meta, Crypto.META_AAD))
        } catch (_: Exception) {
            null // Reported properly by Finisher at the end.
        }
    }

    /**
     * Linear estimate from the rate so far. Late chunks arrive slower (missed
     * frames come back only on the next pass), so this is a lower bound.
     */
    private fun estimateRemaining(elapsed: Long): Long? {
        val total = receiver.total
        val got = receiver.received
        if (total == 0 || got < max(3, total / 20) || elapsed < 2000 || got >= total) return null
        return elapsed * (total - got) / got
    }

    private fun recordFrame() {
        val now = SystemClock.uptimeMillis()
        recentFrames.addLast(now)
        while (recentFrames.isNotEmpty() && now - recentFrames.first() > 2000) recentFrames.removeFirst()
    }

    private fun publish(force: Boolean) {
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastPublish < 100) return
        lastPublish = now
        val elapsed = if (startedAt == 0L) 0L else now - startedAt
        val snapshot = Progress(
            total = receiver.total,
            received = receiver.received,
            hasManifest = receiver.manifest != null,
            fileName = meta?.name,
            fileSize = meta?.size,
            duplicates = receiver.duplicates,
            framesPerSecond = recentFrames.size / 2.0,
            map = receiver.receivedSet(),
            complete = receiver.complete,
            streamRestarted = restarted,
            elapsedMs = elapsed,
            etaMs = estimateRemaining(elapsed),
        )
        restarted = false
        main.post { onProgress(snapshot) }
    }
}
