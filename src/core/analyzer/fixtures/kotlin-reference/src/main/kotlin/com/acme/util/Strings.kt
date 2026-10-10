package com.acme.util

typealias Tag = String

enum class Color { RED, GREEN }

fun String.slugify(): String = lowercase().replace(' ', '-')

infix fun String.tagged(color: Color): Tag = "$this#${color.name}"

private suspend fun <T> load(id: String, parse: (String) -> T): T = parse(id)

suspend fun loadName(id: String): String = load(id) { it.slugify() }

fun listOf(first: String): List<String> = kotlin.collections.listOf(first, first)
