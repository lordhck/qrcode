package com.lordhck.qrtransfer.scan

import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.lordhck.qrtransfer.core.Frame
import com.lordhck.qrtransfer.core.QrPayload
import java.io.Closeable
import java.util.concurrent.Executor

/**
 * Camera frame -> ML Kit -> protocol frame.
 *
 * Results are delivered on [executor], the same single thread that owns the
 * receive session, so the receiver is never touched concurrently.
 */
class FrameAnalyzer(
    private val executor: Executor,
    private val onFrame: (Frame) -> Unit,
    private val onUnreadable: () -> Unit,
) : ImageAnalysis.Analyzer, Closeable {

    private val scanner: BarcodeScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build(),
    )

    @Volatile
    var enabled = true

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
        val media = image.image
        if (!enabled || media == null) {
            image.close()
            return
        }
        val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener(executor) { codes ->
                if (!enabled) return@addOnSuccessListener
                for (code in codes) {
                    // Not every scanner returns binary payloads verbatim;
                    // QrPayload tries each interpretation and verifies the CRC.
                    val frame = QrPayload.extractFrame(code.rawBytes, code.rawValue)
                    if (frame != null) onFrame(frame) else onUnreadable()
                }
            }
            .addOnCompleteListener(executor) { image.close() }
    }

    override fun close() {
        enabled = false
        scanner.close()
    }
}
