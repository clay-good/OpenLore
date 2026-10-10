interface Store { fun load(): String }
class DiskStore : Store { override fun load() = "disk" }
class CachedStore(private val inner: Store) : Store by inner
class Settings(map: Map<String, Any?>) { val name: String by map }
