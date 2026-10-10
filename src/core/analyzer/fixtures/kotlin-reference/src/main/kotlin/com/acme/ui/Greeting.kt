package com.acme.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

@Composable
fun Greeting(name: String) {
    Text(text = "Hello $name")
}

@Composable
fun GreetingList(names: List<String>) {
    names.forEach { Greeting(it) }
}
