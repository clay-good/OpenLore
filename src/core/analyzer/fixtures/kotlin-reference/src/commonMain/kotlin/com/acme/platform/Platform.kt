package com.acme.platform

expect fun platformName(): String

fun banner(): String = "acme on ${platformName()}"
