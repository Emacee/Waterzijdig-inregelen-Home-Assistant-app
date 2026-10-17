# Built on the official Home Assistant base-python image (Alpine + s6-overlay + bashio).
# BUILD_FROM is supplied by the Supervisor from build.yaml.
ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r /app/requirements.txt

COPY run.sh /run.sh
RUN chmod a+x /run.sh

COPY app /app/app

# Ingress: the app listens on 8099 (see config.yaml ingress_port). No host port is
# published. s6-overlay (from the base image) is PID 1 and runs CMD.
CMD [ "/run.sh" ]
