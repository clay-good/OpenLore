package com.acme.android

import com.acme.util.slugify

class Widget(private val title: String) {
    fun key(): String = title.slugify()
}
