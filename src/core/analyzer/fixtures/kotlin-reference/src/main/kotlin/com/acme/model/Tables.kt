package com.acme.model

import org.jetbrains.exposed.sql.Table

object Orders : Table("orders") {
    val id = integer("id").autoIncrement()
    val userId = varchar("user_id", 64)
    val total = long("total")
    override val primaryKey = PrimaryKey(id)
}
