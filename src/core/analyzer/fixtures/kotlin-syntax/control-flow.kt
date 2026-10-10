fun flow(x: Int, items: List<Int>?): String {
    val kind = when (x) {
        0 -> "zero"
        1, 2 -> "small"
        in 3..9 -> "medium"
        else -> "large"
    }
    val size = items?.size ?: return "none"
    outer@ for (i in 0 until size) {
        for (j in 0..i) { if (j == 3) continue@outer; if (j == 5) break@outer }
    }
    var n = 0
    do { n++ } while (n < 3)
    while (n > 0) n--
    return try { kind + items!!.first() } catch (e: NoSuchElementException) { "empty" } finally { println(n) }
}
