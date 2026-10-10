interface Source<out T> { fun next(): T }
interface Sink<in T> { fun put(item: T) }
class Box<T : Comparable<T>>(val value: T) where T : Any
fun <T> copy(from: Array<out T>, to: Array<in T>) {}
fun star(list: List<*>): Int = list.size
typealias Handler<T> = (T) -> Unit
