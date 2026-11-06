# The compositor: Chrome on a virtual display, captured by ffmpeg, pushed to every enabled route.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb pulseaudio ffmpeg chromium fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY station ./station
COPY deploy/station ./deploy/station
ENV CHROME=/usr/bin/chromium STATION_BASE=http://room:8787
CMD ["bash", "deploy/station/compositor.sh"]
