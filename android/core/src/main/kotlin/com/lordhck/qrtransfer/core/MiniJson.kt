package com.lordhck.qrtransfer.core

/**
 * Minimal strict JSON parser (RFC 8259) so the core has no dependencies.
 * Objects -> Map<String, Any?>, arrays -> List<Any?>, integers -> Long,
 * other numbers -> Double.
 */
class JsonException(message: String) : Exception(message)

object MiniJson {
    fun parse(text: String): Any? {
        val p = Parser(text)
        p.skipWhitespace()
        val value = p.value(depth = 0)
        p.skipWhitespace()
        if (!p.atEnd) throw JsonException("trailing data at ${p.pos}")
        return value
    }

    private const val MAX_DEPTH = 64

    private class Parser(private val s: String) {
        var pos = 0
        val atEnd: Boolean get() = pos >= s.length

        fun skipWhitespace() {
            while (pos < s.length && s[pos] in " \t\r\n") pos++
        }

        private fun fail(msg: String): Nothing = throw JsonException("$msg at $pos")

        private fun expect(c: Char) {
            if (pos >= s.length || s[pos] != c) fail("expected '$c'")
            pos++
        }

        fun value(depth: Int): Any? {
            if (depth > MAX_DEPTH) fail("nesting too deep")
            if (atEnd) fail("unexpected end")
            return when (val c = s[pos]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c in '0'..'9') num() else fail("unexpected '$c'")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, pos)) fail("invalid literal")
            pos += word.length
            return v
        }

        private fun obj(depth: Int): Map<String, Any?> {
            expect('{')
            val out = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (pos < s.length && s[pos] == '}') { pos++; return out }
            while (true) {
                skipWhitespace()
                if (atEnd || s[pos] != '"') fail("expected key")
                val key = str()
                skipWhitespace()
                expect(':')
                skipWhitespace()
                out[key] = value(depth + 1)
                skipWhitespace()
                if (atEnd) fail("unterminated object")
                if (s[pos] == ',') { pos++; continue }
                expect('}')
                return out
            }
        }

        private fun arr(depth: Int): List<Any?> {
            expect('[')
            val out = ArrayList<Any?>()
            skipWhitespace()
            if (pos < s.length && s[pos] == ']') { pos++; return out }
            while (true) {
                skipWhitespace()
                out.add(value(depth + 1))
                skipWhitespace()
                if (atEnd) fail("unterminated array")
                if (s[pos] == ',') { pos++; continue }
                expect(']')
                return out
            }
        }

        private fun str(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                if (atEnd) fail("unterminated string")
                val c = s[pos++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (atEnd) fail("bad escape")
                        when (val e = s[pos++]) {
                            '"', '\\', '/' -> sb.append(e)
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > s.length) fail("bad unicode escape")
                                val code = s.substring(pos, pos + 4).toIntOrNull(16) ?: fail("bad unicode escape")
                                sb.append(code.toChar())
                                pos += 4
                            }
                            else -> fail("bad escape '\\$e'")
                        }
                    }
                    c < ' ' -> fail("control character in string")
                    else -> sb.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = pos
            if (s[pos] == '-') pos++
            if (atEnd || s[pos] !in '0'..'9') fail("bad number")
            if (s[pos] == '0') pos++ else while (pos < s.length && s[pos] in '0'..'9') pos++
            var isInt = true
            if (pos < s.length && s[pos] == '.') {
                isInt = false
                pos++
                if (atEnd || s[pos] !in '0'..'9') fail("bad number")
                while (pos < s.length && s[pos] in '0'..'9') pos++
            }
            if (pos < s.length && (s[pos] == 'e' || s[pos] == 'E')) {
                isInt = false
                pos++
                if (pos < s.length && (s[pos] == '+' || s[pos] == '-')) pos++
                if (atEnd || s[pos] !in '0'..'9') fail("bad number")
                while (pos < s.length && s[pos] in '0'..'9') pos++
            }
            val text = s.substring(start, pos)
            return if (isInt) text.toLongOrNull() ?: text.toDouble() else text.toDouble()
        }
    }
}
