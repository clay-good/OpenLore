fun strings(name: String, n: Int): String {
    val simple = "Hello $name"
    val expr = "Total ${n + 1} for ${name.uppercase()}"
    val raw = """
        |line $name
        |braces { } and "quotes"
    """.trimMargin()
    val c = '\n'
    return simple + expr + raw + c
}
