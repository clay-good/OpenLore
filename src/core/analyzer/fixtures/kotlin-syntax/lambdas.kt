val double: (Int) -> Int = { it * 2 }
val sum = fun(a: Int, b: Int): Int { return a + b }
fun higher(f: (Int) -> Int, g: Int.() -> Int): Int = f(1) + 2.g()
fun useThem() {
    listOf(1, 2).map { it + 1 }.filter { v -> v > 1 }.forEach(::println)
    run { higher({ it }, { this }) }
    val ref = String::length
    listOf("a").forEach { item -> if (item.isEmpty()) return@forEach; println(item) }
}
