fun ranges(map: Map<String, Int>): Int {
    var total = 0
    for ((key, value) in map) { total += key.length + value }
    for (i in 10 downTo 0 step 2) total += i
    val (a, _, c) = Triple(1, 2, 3)
    return total + a + c
}
