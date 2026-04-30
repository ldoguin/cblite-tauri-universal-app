FROM rust:1.78-slim AS builder
WORKDIR /app
# Cache dependencies
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src
# Build the real binary
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/cblite-auth-server /usr/local/bin/cblite-auth-server
EXPOSE 3000
CMD ["cblite-auth-server"]
