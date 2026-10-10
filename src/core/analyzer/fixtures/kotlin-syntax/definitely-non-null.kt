fun <T> elvisLike(value: T, fallback: T & Any): T & Any = value ?: fallback
