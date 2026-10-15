# CI builds only this directory. The application and host credentials are absent.
# Version tags are explicit; CI records image IDs and dpkg versions. See README.
FROM rust:1.99.0-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends libkrb5-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /probe
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo test --locked && cargo build --release --locked

FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    krb5-kdc krb5-admin-server krb5-user openssh-server libgssapi-krb5-2 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /fixture/home --shell /bin/sh p0gss \
    && passwd -d p0gss && mkdir -p /run/sshd \
    && touch /p0-gssapi-disposable-image
RUN command -v kadmin.local && command -v kdb5_util && command -v krb5kdc \
    && command -v kinit && command -v klist && command -v kvno && command -v sshd
COPY --from=build /probe/target/release/p0-gssapi-probe /usr/local/bin/p0-gssapi-probe
COPY fixture.sh /usr/local/bin/p0-gssapi-fixture
ENTRYPOINT ["/bin/bash", "/usr/local/bin/p0-gssapi-fixture"]
