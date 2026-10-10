sealed interface Result<out T>
data class Ok<T>(val value: T) : Result<T>
data object Missing : Result<Nothing>
sealed class Failure(val reason: String) : Result<Nothing> { class Timeout : Failure("timeout") }
@JvmInline value class UserId(val raw: String)
fun render(r: Result<String>): String = when (r) {
    is Ok -> r.value
    Missing -> "missing"
    is Failure -> r.reason
}
