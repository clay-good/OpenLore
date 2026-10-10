suspend fun fetch(id: String): String = id
suspend fun <T> retry(times: Int, block: suspend () -> T): T { repeat(times - 1) { runCatching { return block() } }; return block() }
val handler: suspend (String) -> Unit = { fetch(it) }
