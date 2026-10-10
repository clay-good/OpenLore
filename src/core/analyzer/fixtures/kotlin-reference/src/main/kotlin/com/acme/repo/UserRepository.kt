package com.acme.repo

import com.acme.model.User

interface UserRepository {
    fun save(user: User): User
    fun find(id: String): User?
}

class InMemoryUserRepository : UserRepository {
    private val users = mutableMapOf<String, User>()

    override fun save(user: User): User {
        users[user.id] = user
        return user
    }

    override fun find(id: String): User? = users[id]
}

class AuditedUserRepository(private val inner: UserRepository) : UserRepository by inner {
    override fun save(user: User): User {
        audit(user)
        return inner.save(user)
    }

    private fun audit(user: User) {}
}
