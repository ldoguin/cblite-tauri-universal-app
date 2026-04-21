FROM couchbase/server-sandbox:8.0.0

ENV PATH $PATH:/opt/couchbase-sync-gateway/bin

# Install dependencies:
#  wget: for downloading Sync Gateway package installer
RUN set -x \
    && apt update \
    && apt install -y \
           curl \
           lsb-release \
           systemctl \
           wget \
    && apt clean

# Install Sync Gateway 4.0.4 (latest)
ARG SGW_PACKAGE="https://packages.couchbase.com/releases/couchbase-sync-gateway/4.0.4/couchbase-sync-gateway-enterprise_4.0.4_@@ARCH@@.deb"
RUN set -x \
    && SGW_PACKAGE=$(echo "${SGW_PACKAGE}" | sed -e "s/@@ARCH@@/$(uname -m)/") \
    && SGW_PACKAGE_FILENAME=$(echo "couchbase-sync-gateway-enterprise_4.0.4_@@ARCH@@.deb" | sed -e "s/@@ARCH@@/$(uname -m)/") \
    && wget "${SGW_PACKAGE}" \
    && apt install -y ./"${SGW_PACKAGE_FILENAME}" \
    && rm "${SGW_PACKAGE_FILENAME}" \
    && apt autoremove -y \
    && apt clean -y

# Create directory where the default config stores memory snapshots to disk
RUN mkdir /opt/couchbase-sync-gateway/data

# Create log dir
RUN set -x \
    && mkdir -p /var/log/sync_gateway \
    && chown sync_gateway:sync_gateway /var/log/sync_gateway

# Add bootstrap script
COPY sg.sh /etc/service/sg-couchbase/run
RUN chown -R couchbase:couchbase /etc/service
COPY config.json /sync-gateway-config.json

VOLUME /var/log/sync_gateway
RUN chown -R couchbase:couchbase /var/log/sync_gateway

# Expose ports
#  port 4984: public port
EXPOSE 4984
#  port 4985: admin port
EXPOSE 4985
#  port 4986: metrics port
EXPOSE 4986