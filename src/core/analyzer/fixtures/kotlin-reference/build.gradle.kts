plugins {
    kotlin("jvm") version "2.2.0"
    kotlin("plugin.spring") version "2.2.0"
    application
}

group = "com.acme"
version = providers.gradleProperty("acmeVersion").getOrElse("0.0.1")

application {
    mainClass.set("com.acme.ApplicationKt")
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web:3.4.0")
    implementation("io.ktor:ktor-server-netty:3.0.0")
    implementation("io.ktor:ktor-client-cio:3.0.0")
    implementation("org.jetbrains.exposed:exposed-core:0.56.0")
    implementation("jakarta.persistence:jakarta.persistence-api:3.1.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
    testImplementation("io.kotest:kotest-runner-junit5:5.9.1")
}

tasks.register("printRegion") {
    val region = providers.environmentVariable("ACME_REGION").orElse("local")
    doLast { println(region.get()) }
}
