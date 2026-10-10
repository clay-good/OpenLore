open class Base(val id: Int) { open fun describe(): String = "base" }
class Derived(id: Int, private val name: String) : Base(id), Comparable<Derived> {
    constructor(name: String) : this(0, name)
    init { require(name.isNotEmpty()) }
    override fun describe(): String = name
    override fun compareTo(other: Derived): Int = id - other.id
    companion object Factory { fun make(): Derived = Derived("x") }
    inner class Inner { fun outerName() = name }
}
object Registry { val items = mutableListOf<Base>() }
data class Point(val x: Int, val y: Int)
enum class Level(val weight: Int) { LOW(1), HIGH(2) { override fun toString() = "high" }; }
annotation class Marker(val value: String)
abstract class Shape { abstract fun area(): Double }
