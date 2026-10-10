package com.acme.client

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText

class OrderClient(private val client: HttpClient) {
    suspend fun fetch(id: String): String =
        client.get("http://orders.internal/api/orders/$id").bodyAsText()
}

suspend fun fetchHealth(client: HttpClient): String = client.get("http://orders.internal/health").bodyAsText()
