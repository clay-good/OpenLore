package com.acme.legacy;

import com.acme.config.Env;
import com.acme.repo.StoresKt;
import com.acme.service.UserService;

public class LegacyCaller {
    public int port() {
        return Env.INSTANCE.port();
    }

    public UserService service() {
        return UserService.Companion.inMemory();
    }

    public Object store() {
        return StoresKt.openStore();
    }
}
