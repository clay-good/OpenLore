fun nulls(a: String?, b: Any): Int {
    val len = a?.length ?: 0
    val forced = a!!.length
    val cast = b as? String
    val hard = b as CharSequence
    if (b is String && b.isNotEmpty()) return b.length
    return len + forced + (cast?.length ?: 0) + hard.length
}
