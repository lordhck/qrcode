package com.lordhck.qrtransfer.receive

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import com.lordhck.qrtransfer.core.FileNames
import com.lordhck.qrtransfer.core.ReceivedFile
import java.io.IOException

/** Writes received files to Downloads/QR Transfer via MediaStore (no storage permission). */
object Saver {
    private val MIME_RE = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")
    private const val FOLDER = "QR Transfer"

    fun mimeType(declared: String): String {
        val type = declared.lowercase().substringBefore(';').trim()
        return if (MIME_RE.matches(type)) type else "application/octet-stream"
    }

    fun save(context: Context, file: ReceivedFile): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, FileNames.sanitize(file.meta.name))
            put(MediaStore.Downloads.MIME_TYPE, mimeType(file.meta.type))
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("Downloads is not available")
        try {
            resolver.openOutputStream(uri)?.use { it.write(file.data) }
                ?: throw IOException("Could not open the output file")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return uri
    }
}
