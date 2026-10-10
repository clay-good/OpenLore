package com.acme.repo

fun openStore(): UserRepository = AuditedUserRepository(InMemoryUserRepository())

val defaultStore: UserRepository = openStore()
