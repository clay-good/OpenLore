package com.acme.plugin

import java.util.ServiceLoader
import kotlin.reflect.full.memberFunctions

interface Plugin {
    fun start()
}

fun startAll() {
    for (plugin in ServiceLoader.load(Plugin::class.java)) {
        plugin.start()
    }
}

fun invokeByName(target: Any, name: String) {
    val fn = target::class.memberFunctions.first { it.name == name }
    fn.call(target)
}

fun loadClass(name: String): Any = Class.forName(name).getDeclaredConstructor().newInstance()
