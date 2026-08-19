# Private replay terminal

This stack runs the same browser/API boundary used by the live product while keeping the historical corpus and replay owner private. The replay container has no network namespace and reads the corpus read-only. Only Nginx binds a host port, and that port is loopback-only; use an IAP or SSH tunnel instead of adding a public VM address.

The deployment intentionally uses one colocated Postgres instance in development mode. It is a bounded replay lab, not the production database topology. Live financial submission, live wallet polling, and external notification providers remain disabled.

Create a mode-600 environment file from `env.example`. Set `FERVOR_SECRET_GID` to the
numeric group that owns the replay auth and token files, and grant that group read access:

```sh
chgrp "$(id -g)" /secure/path/replay-api-auth.json /secure/path/replay-api-token
chmod 640 /secure/path/replay-api-auth.json /secure/path/replay-api-token
```

Then run:

```sh
docker compose --env-file /secure/path/fervor-replay.env -f deploy/replay/compose.yml up -d --build
```

The exact externally visible origin must match `FERVOR_FRONTEND_URL`; this includes a Cloud Shell Web Preview origin. For a local IAP tunnel, use `http://localhost:8080` and forward local port 8080 to VM port 8080.

Replay frontend builds send the app JWT in `X-Fervor-Replay-Session` because Google's
authenticated preview proxies reserve the standard `Authorization` header. The API accepts
that alternate header only while `REPLAY_API_SOCKET` is configured; live builds continue to
use `Authorization: Bearer`.

After startup, verify the loopback edge and service health:

```sh
curl --fail http://127.0.0.1:8080/health
docker compose --env-file /secure/path/fervor-replay.env -f deploy/replay/compose.yml ps
```

Every replay caller must authenticate through the normal nonce/signature flow. A private lab accepts any authenticated demo session by default, which keeps an ephemeral replay wallet usable after browser storage is cleared. Set `FERVOR_REPLAY_USER_ID` to an ordinary Fervor user UUID only when the lab must be restricted to one account. No chain transaction or funded wallet is required.
