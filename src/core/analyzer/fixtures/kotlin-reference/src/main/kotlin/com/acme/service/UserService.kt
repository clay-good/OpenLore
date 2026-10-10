package com.acme.service

import com.acme.model.User
import com.acme.repo.UserRepository
import com.acme.util.Color
import com.acme.util.slugify
import com.acme.util.tagged

class UserNotFound(id: String) : RuntimeException("no user $id")

class UserService(private val repo: UserRepository) {

    private val audit: (String) -> Unit = { line -> record(line) }

    var created: Int = 0
        private set

    val summary: String
        get() = render(created)

    init {
        warm()
    }

    constructor(repo: UserRepository, seed: String) : this(repo) {
        create(seed)
    }

    fun create(name: String): User {
        val user = User(id = name.slugify(), name = name)
        repo.save(user)
        created += 1
        listOf(name).forEach(::report)
        audit(name tagged Color.RED)
        return user
    }

    fun find(id: String): User? = repo.find(id)

    fun require(id: String): User = repo.find(id) ?: throw UserNotFound(id)

    fun describe(id: String?): String {
        val key = id ?: return "anonymous"
        return try {
            when (val user = require(key)) {
                is User -> label(user)
                else -> "unknown"
            }
        } catch (e: UserNotFound) {
            "missing"
        }
    }

    fun safeDescribe(id: String): String = runCatching { require(id).name }.getOrDefault("none")

    private fun label(user: User): String = user.name.slugify()

    private fun report(name: String) {
        record("created $name")
    }

    private fun record(line: String) {
        println(line)
    }

    private fun warm() {}

    private fun render(count: Int): String = "users=$count"

    companion object {
        fun inMemory(): UserService = UserService(com.acme.repo.InMemoryUserRepository())
    }
}
