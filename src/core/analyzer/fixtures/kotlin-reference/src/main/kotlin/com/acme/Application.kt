package com.acme

import com.acme.client.OrderClient
import com.acme.config.Env
import com.acme.repo.*
import com.acme.service.UserService
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

fun main() {
    embeddedServer(Netty, port = Env.port()) { module() }.start(wait = true)
}

fun Application.module() {
    val service = UserService(openStore())
    install(CallLogging)
    routing {
        get("/health") {
            call.respondText("ok")
        }
        route("/users") {
            post {
                call.respondText(service.create("ktor").name)
            }
            get("/{id}") {
                call.respondText(service.describe(call.parameters["id"]))
            }
        }
    }
}

suspend fun warmUp(orders: OrderClient): String = orders.fetch("1")
