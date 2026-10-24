# One POS database image: PostgreSQL 17 (the version One POS is developed on) + pgBackRest for point-in-time recovery.
# The application server's backup container uses the same image (pg_dump 17, rsync, ssh). Context = deploy/.
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest rsync openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY data/initdb/ /docker-entrypoint-initdb.d/
COPY data/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY data/db-entrypoint.sh /usr/local/bin/onepos-db-entrypoint
COPY data/app-backup.sh /usr/local/bin/onepos-app-backup
RUN sed -i 's/\r$//' /docker-entrypoint-initdb.d/*.sh /usr/local/bin/onepos-* \
 && chmod +x /docker-entrypoint-initdb.d/*.sh /usr/local/bin/onepos-*
