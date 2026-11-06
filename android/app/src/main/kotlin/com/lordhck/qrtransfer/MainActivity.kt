package com.lordhck.qrtransfer

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.Formatter
import android.util.Size
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.lordhck.qrtransfer.receive.Outcome
import com.lordhck.qrtransfer.receive.Progress
import com.lordhck.qrtransfer.receive.ReceiveSession
import com.lordhck.qrtransfer.scan.FrameAnalyzer
import com.lordhck.qrtransfer.ui.ChunkMapView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private enum class State { PERMISSION, SCANNING, FINISHING, DONE, FAILED }

    private lateinit var preview: PreviewView
    private lateinit var viewfinder: View
    private lateinit var title: TextView
    private lateinit var detail: TextView
    private lateinit var progress: ProgressBar
    private lateinit var chunkMap: ChunkMapView
    private lateinit var stats: TextView
    private lateinit var primary: Button
    private lateinit var secondary: Button
    private lateinit var tertiary: Button

    /** Single thread shared by ML Kit callbacks and the receiver. */
    private lateinit var worker: ExecutorService
    private lateinit var session: ReceiveSession
    private lateinit var analyzer: FrameAnalyzer
    private var cameraProvider: ProcessCameraProvider? = null
    private var state = State.PERMISSION
    private var lastOutcome: Outcome.Saved? = null

    private val requestCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startScanning() else showPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        preview = findViewById(R.id.preview)
        viewfinder = findViewById(R.id.viewfinder)
        title = findViewById(R.id.title)
        detail = findViewById(R.id.detail)
        progress = findViewById(R.id.progress)
        chunkMap = findViewById(R.id.chunkMap)
        stats = findViewById(R.id.stats)
        primary = findViewById(R.id.primary)
        secondary = findViewById(R.id.secondary)
        tertiary = findViewById(R.id.tertiary)

        worker = Executors.newSingleThreadExecutor { r -> Thread(r, "qrt-receiver") }
        session = ReceiveSession(applicationContext, worker, ::onProgress)
        analyzer = FrameAnalyzer(worker, session::onFrame, session::onUnreadable)

        if (hasCameraPermission()) startScanning() else requestCamera.launch(Manifest.permission.CAMERA)
    }

    override fun onDestroy() {
        super.onDestroy()
        analyzer.close()
        session.close()
        worker.shutdown()
    }

    private fun hasCameraPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    // -- Camera -----------------------------------------------------------------------

    private fun bindCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            cameraProvider = provider
            val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            // Dense QR codes need resolution; 1080p is a good speed/detail balance.
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                        )
                        .build(),
                )
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(worker, analyzer) }
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    private fun unbindCamera() {
        cameraProvider?.unbindAll()
    }

    // -- States -----------------------------------------------------------------------

    private fun startScanning() {
        state = State.SCANNING
        lastOutcome = null
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        session.reset()
        analyzer.enabled = true
        bindCamera()
        viewfinder.visibility = View.VISIBLE
        title.text = getString(R.string.scan_title)
        detail.text = getString(R.string.scan_hint)
        progress.visibility = View.VISIBLE
        progress.progress = 0
        chunkMap.visibility = View.VISIBLE
        chunkMap.update(0, java.util.BitSet())
        stats.visibility = View.VISIBLE
        stats.text = getString(R.string.waiting_first)
        buttons(primaryText = null, secondaryText = getString(R.string.restart) to { startScanning() })
    }

    private fun onProgress(p: Progress) {
        if (state != State.SCANNING) return
        if (p.streamRestarted) Toast.makeText(this, R.string.new_stream, Toast.LENGTH_SHORT).show()
        title.text = when {
            p.fileName != null -> getString(R.string.receiving, p.fileName)
            p.total > 0 -> getString(R.string.receiving_unknown)
            else -> getString(R.string.scan_title)
        }
        if (p.total > 0) {
            val percent = p.received * 100 / p.total
            detail.text = getString(R.string.chunks_progress, p.received, p.total, percent) +
                (p.fileSize?.let { " · " + Formatter.formatShortFileSize(this, it) } ?: "")
            progress.progress = p.received * 1000 / p.total
        }
        chunkMap.update(p.total, p.map)
        val manifest = getString(if (p.hasManifest) R.string.manifest_ok else R.string.manifest_wait)
        stats.text = getString(R.string.stats, manifest, p.framesPerSecond, p.duplicates)

        if (p.complete) finishTransfer()
    }

    private fun finishTransfer() {
        state = State.FINISHING
        analyzer.enabled = false
        unbindCamera()
        viewfinder.visibility = View.GONE
        title.text = getString(R.string.finishing)
        progress.isIndeterminate = true
        buttons(null)
        session.finish(::onOutcome)
    }

    private fun onOutcome(outcome: Outcome) {
        progress.isIndeterminate = false
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        title.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS,
        )
        when (outcome) {
            is Outcome.Saved -> {
                state = State.DONE
                lastOutcome = outcome
                title.text = getString(R.string.done_title, outcome.name)
                detail.text = getString(R.string.done_detail, Formatter.formatShortFileSize(this, outcome.size))
                progress.progress = 1000
                stats.visibility = View.GONE
                buttons(
                    primaryText = getString(R.string.open) to { open(outcome) },
                    secondaryText = getString(R.string.share) to { share(outcome) },
                    tertiaryText = getString(R.string.receive_another) to { startScanning() },
                )
            }
            is Outcome.Failed -> {
                state = State.FAILED
                title.text = getString(R.string.failed_title)
                detail.text = outcome.message
                progress.visibility = View.GONE
                chunkMap.visibility = View.GONE
                stats.visibility = View.GONE
                buttons(primaryText = getString(R.string.try_again) to { startScanning() })
            }
        }
    }

    private fun showPermission() {
        state = State.PERMISSION
        viewfinder.visibility = View.GONE
        title.text = getString(R.string.permission_title)
        detail.text = getString(R.string.permission_detail)
        progress.visibility = View.GONE
        chunkMap.visibility = View.GONE
        stats.visibility = View.GONE
        // After a permanent denial the system dialog no longer appears.
        val canAsk = shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
        buttons(
            primaryText = if (canAsk) {
                getString(R.string.allow_camera) to { requestCamera.launch(Manifest.permission.CAMERA) }
            } else {
                getString(R.string.open_settings) to {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                }
            },
        )
    }

    override fun onResume() {
        super.onResume()
        if (state == State.PERMISSION && hasCameraPermission()) startScanning()
    }

    // -- Actions ------------------------------------------------------------------------

    private fun open(saved: Outcome.Saved) {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(saved.uri, saved.mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_to_open, Toast.LENGTH_SHORT).show()
        }
    }

    private fun share(saved: Outcome.Saved) {
        val intent = Intent(Intent.ACTION_SEND)
            .setType(saved.mimeType)
            .putExtra(Intent.EXTRA_STREAM, saved.uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(intent, saved.name))
    }

    private fun buttons(
        primaryText: Pair<String, () -> Unit>?,
        secondaryText: Pair<String, () -> Unit>? = null,
        tertiaryText: Pair<String, () -> Unit>? = null,
    ) {
        for ((button, spec) in listOf(primary to primaryText, secondary to secondaryText, tertiary to tertiaryText)) {
            if (spec == null) {
                button.visibility = View.GONE
            } else {
                button.visibility = View.VISIBLE
                button.text = spec.first
                button.setOnClickListener { spec.second() }
            }
        }
    }
}
