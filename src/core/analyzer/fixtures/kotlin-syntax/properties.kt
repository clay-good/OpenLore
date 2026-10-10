class Holder {
    var label: String = ""
        get() = field.trim()
        set(value) { field = value.lowercase() }
    val lazyValue: Int by lazy { 42 }
    lateinit var late: String
    private var counter = 0
    val size: Int get() = counter
}
const val LIMIT = 10
val topLevel: List<String> = emptyList()
