fun outer(): Int {
    fun local(x: Int) = x + 1
    class Scoped(val v: Int) { fun twice() = v * 2 }
    val anon = fun(x: Int) = x
    return local(1) + Scoped(2).twice() + anon(3)
}
