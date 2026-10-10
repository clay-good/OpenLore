interface Listener { fun on(event: String) }
fun listen(): Listener = object : Listener { override fun on(event: String) { println(event) } }
val anonymous = object { val x = 1; fun twice() = x * 2 }
