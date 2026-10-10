package com.acme.config

object Env {
    fun port(): Int = (System.getenv("ACME_PORT") ?: "8080").toInt()

    fun databaseUrl(): String = System.getenv("ACME_DATABASE_URL")
        ?: error("ACME_DATABASE_URL is required")

    fun token(): String = System.getenv().getValue("ACME_TOKEN")
}
