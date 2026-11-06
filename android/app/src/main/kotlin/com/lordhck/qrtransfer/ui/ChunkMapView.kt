package com.lordhck.qrtransfer.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.lordhck.qrtransfer.R
import java.util.BitSet
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Shows which chunks have arrived. Draws one cell per chunk when they fit at
 * a visible size, otherwise a strip where each pixel column covers a range of
 * chunks and is shaded by how many of them are present.
 */
class ChunkMapView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val have = Paint().apply { color = ContextCompat.getColor(context, R.color.ok) }
    private val missing = Paint().apply { color = ContextCompat.getColor(context, R.color.missing) }
    private val partial = Paint()

    private var total = 0
    private var map = BitSet()

    fun update(total: Int, map: BitSet) {
        this.total = total
        this.map = map
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (total <= 0) {
            canvas.drawRect(0f, 0f, w, h, missing)
            return
        }
        val gap = 1f * resources.displayMetrics.density
        val cell = floor(sqrt(w * h / total))
        if (cell >= 4 * resources.displayMetrics.density) {
            val cols = max(1, floor(w / cell).toInt())
            val rows = ceil(total.toDouble() / cols).toInt()
            val size = minOf(w / cols, h / rows)
            for (i in 0 until total) {
                val x = (i % cols) * size
                val y = (i / cols) * size
                canvas.drawRect(x, y, x + size - gap, y + size - gap, if (map.get(i)) have else missing)
            }
        } else {
            val columns = w.toInt()
            for (px in 0 until columns) {
                val from = (px.toLong() * total / columns).toInt()
                val to = max(from + 1, ((px + 1).toLong() * total / columns).toInt())
                var got = 0
                for (i in from until to) if (map.get(i)) got++
                val paint = when (got) {
                    0 -> missing
                    to - from -> have
                    else -> partial.apply { color = blend(missing.color, have.color, got.toFloat() / (to - from)) }
                }
                canvas.drawRect(px.toFloat(), 0f, px + 1f, h, paint)
            }
        }
    }

    private fun blend(a: Int, b: Int, t: Float): Int {
        fun ch(shift: Int) = ((a shr shift and 0xFF) * (1 - t) + (b shr shift and 0xFF) * t).toInt() shl shift
        return (0xFF shl 24) or ch(16) or ch(8) or ch(0)
    }
}
