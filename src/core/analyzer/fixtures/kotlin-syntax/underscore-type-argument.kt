abstract class Loader<T> { abstract fun load(): T }
class IntLoader : Loader<Int>() { override fun load() = 1 }
inline fun <reified S : Loader<T>, T> run(): T = TODO()
val loaded = run<IntLoader, _>()
