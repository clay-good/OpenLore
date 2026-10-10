@file:JvmName("Annotated")
package sample

@Target(AnnotationTarget.FUNCTION)
annotation class Route(val path: String)

class Api {
    @Route("/{id}")
    @Deprecated("use other", ReplaceWith("other()"))
    fun get(@Suppress("UNUSED_PARAMETER") id: String): String = id

    @get:JvmName("flag") val flag: Boolean = true
    @JvmStatic @Throws(IllegalStateException::class) fun risky() {}
}
