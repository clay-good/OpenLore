package com.acme.model

data class Money(val cents: Long) {
    operator fun plus(other: Money): Money = Money(cents + other.cents)

    val isZero: Boolean
        get() = cents == 0L
}

fun total(a: Money, b: Money): Money = a + b
