fun plain(a: Int, b: Int = 2): Int { return a + b }
fun expressionBody(a: Int) = a * 2
fun <T> generic(item: T): List<T> = listOf(item)
fun String.extension(): Int = length
infix fun Int.plusInfix(other: Int): Int = this + other
tailrec fun countDown(n: Int): Int = if (n == 0) 0 else countDown(n - 1)
inline fun <reified T> isA(value: Any): Boolean = value is T
fun varargs(vararg items: String) = items.size
