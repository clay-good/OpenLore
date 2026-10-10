fun firstNegative(items: List<Int>): Int? {
    for (item in items) {
        items.forEach { if (it == 0) continue; if (it < 0) break }
        if (item < 0) return item
    }
    return null
}
