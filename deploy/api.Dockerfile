# One POS API image. Built from the repository root by deploy/release.sh (context = repo root, .dockerignore keeps it small).
# The same image runs on test and live; everything that differs is in the environment's .env (deploy/README.md).

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Directory.Build.props BannedSymbols.txt ./
COPY src/OnePos.Api/ src/OnePos.Api/
COPY db/ db/
RUN dotnet publish src/OnePos.Api/OnePos.Api.csproj -c Release -r linux-x64 --self-contained -o /out --nologo

# Debian + a self-contained build (as AWS One). libgssapi: SqlClient loads it when connecting to FACTS (SQL Server).
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu76 libgssapi-krb5-2 ca-certificates tzdata curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1654 --user-group --no-create-home --home-dir /app app \
 && mkdir -p /data && chown 1654:1654 /data
WORKDIR /app
COPY --from=build /out .
ARG VERSION=dev
ENV ASPNETCORE_URLS=http://+:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true \
    HOME=/tmp \
    DataProtection__Keys=/data/keys \
    Images__Root=/data/images \
    Releases__Root=/data/releases/device-service \
    ONEPOS_VERSION=$VERSION
LABEL org.opencontainers.image.title="onepos-api" org.opencontainers.image.version=$VERSION
USER 1654
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=4 CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/app/OnePos.Api"]
