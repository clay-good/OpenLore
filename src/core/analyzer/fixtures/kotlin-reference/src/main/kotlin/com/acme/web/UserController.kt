package com.acme.web

import com.acme.model.User
import com.acme.service.UserService
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * REST surface for users.
 *
 * @property service the user service
 */
@RestController
@RequestMapping("/api/users")
class UserController(private val service: UserService) {

    /** Returns one user by [id]. */
    @GetMapping("/{id}")
    fun get(@PathVariable id: String): User? {
        return service.find(id)
    }

    @PostMapping
    fun create(name: String): User = this.service.create(name)
}
