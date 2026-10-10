data class Vec(val x: Int, val y: Int) {
    operator fun plus(o: Vec) = Vec(x + o.x, y + o.y)
    operator fun get(i: Int) = if (i == 0) x else y
    operator fun invoke(scale: Int) = Vec(x * scale, y * scale)
    operator fun component3() = x + y
}
fun ops(a: Vec, b: Vec): Int {
    val (x, y) = a + b
    val scaled = a(2)
    var total = a[0] + scaled[1]
    total += x; total -= y; total *= 2; total++
    return if (total in 1..10 && total !in 3..4) total else -total
}
