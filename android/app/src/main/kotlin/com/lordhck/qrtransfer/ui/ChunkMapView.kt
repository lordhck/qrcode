package com.lordhck.qrtransfer.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.lordhck.qrtransfer.R
import java.util.BitSet
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Shows which chunks have arrived. Draws a centred grid with one cell per
 * chunk when the cells fit at a visible size; otherwise a full-width strip
 * where each pixel column covers a range of chunks, shaded by how many of
 * them are present.
 */
class ChunkMapView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val density = resources.displayMetrics.density
    private val minCell = 4 * density
    private val maxCell = 28 * density
    private val gap = 1.5f * density
    private val radius = 2 * density

    private val have = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.ok) }
    private val missing = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.missing) }
    private val partial = Paint()
    private val rect = RectF()

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
            rect.set(0f, 0f, w, h)
            canvas.drawRoundRect(rect, radius, radius, missing)
            return
        }
        val layout = bestGrid(w, h)
        if (layout != null) drawGrid(canvas, w, h, layout) else drawStrip(canvas, w, h)
    }

    private class Grid(val cols: Int, val rows: Int, val cell: Float)

    /** Column count that gives the largest square cells, or null if cells would be too small. */
    private fun bestGrid(w: Float, h: Float): Grid? {
        var best: Grid? = null
        for (cols in 1..total) {
            val rows = ceil(total.toDouble() / cols).toInt()
            val cell = min(min(w / cols, h / rows), maxCell)
            if (best == null || cell > best.cell) best = Grid(cols, rows, cell)
            if (w / cols < minCell) break
        }
        return best?.takeIf { it.cell >= minCell }
    }

    private fun drawGrid(canvas: Canvas, w: Float, h: Float, g: Grid) {
        // Centre the whole grid; the last row is centred on its own too.
        val gridH = g.rows * g.cell
        val top = (h - gridH) / 2
        for (i in 0 until total) {
            val row = i / g.cols
            val inRow = if (row == g.rows - 1) total - row * g.cols else g.cols
            val left = (w - inRow * g.cell) / 2
            val x = left + (i % g.cols) * g.cell
            val y = top + row * g.cell
            rect.set(x + gap / 2, y + gap / 2, x + g.cell - gap / 2, y + g.cell - gap / 2)
            canvas.drawRoundRect(rect, radius, radius, if (map.get(i)) have else missing)
        }
    }

    private fun drawStrip(canvas: Canvas, w: Float, h: Float) {
        val columns = max(1, w.toInt())
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

    private fun blend(a: Int, b: Int, t: Float): Int {
        fun ch(shift: Int) = ((a shr shift and 0xFF) * (1 - t) + (b shr shift and 0xFF) * t).toInt() shl shift
        return (0xFF shl 24) or ch(16) or ch(8) or ch(0)
    }
}
