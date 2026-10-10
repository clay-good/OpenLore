fun interface Transformer { fun apply(input: String): String }
val upper = Transformer { it.uppercase() }
fun useTransformer(t: Transformer): String = t.apply("x")
