sealed interface Animal { data class Cat(val mouseHunter: Boolean) : Animal; data object Dog : Animal }
fun feed(animal: Animal): String = when (animal) {
    is Animal.Dog -> "dog"
    is Animal.Cat if !animal.mouseHunter -> "cat"
    else -> "other"
}
