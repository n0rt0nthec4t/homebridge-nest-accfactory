# version of node docker we will use. pass in via build eg: 20-alpine
ARG NODE_VERSION

# version of our project. pass in via build eg: 0.0.1-alpha.1
ARG NEST_ACCFACTORY_VERSION

# first up, we'll install ffmpeg-for-homebrige so we can just extract the ffmpeg binary to be included in the final image
FROM node:${NODE_VERSION} AS builder

WORKDIR /build
RUN npm install ffmpeg-for-homebridge

# build our nodejs app container now
FROM node:${NODE_VERSION} AS app
ARG FFMPEG_VERSION
ARG NEST_ACCFACTORY_VERSION

# Add extra libraries we'll need for timezone support and our compiled ffmpeg binary
# Pass TZ env from docker run to set timezone
RUN apk update \
    && apk upgrade \
    && apk add tzdata

# working directory inside the container
WORKDIR /opt/Nest_accfactory
RUN mkdir ${WORKDIR}/dist

# copy require files into container image folder
COPY src/*.js ./dist/
COPY src/res/ ./dist/res/
COPY src/protobuf/ ./dist/protobuf/
COPY --from=builder /build/node_modules/ffmpeg-for-homebridge/ffmpeg ./dist
COPY src/docker-standalone/*.js ./dist/
COPY src/docker-standalone/package.json ./

# perform installation based on details in package.json
RUN npm update -g \
    && npm install --omit=dev

# tidy up install by removing sample accessories from hap-nodejs
RUN rm -rf ./node_modules/hap-nodejs/dist/accessories
RUN mkdir ./node_modules/hap-nodejs/dist/accessories
RUN cp ./node_modules/hap-nodejs/dist/types.* ./node_modules/hap-nodejs/dist/accessories/

# fixup file ownership to match non-root user, "node"
RUN chown -R node:node /opt/Nest_accfactory

# run the accessory, using non-root user, "node"
USER node
ENTRYPOINT ["node", "/opt/Nest_accfactory/dist/index.js", "/opt/Nest_accfactory/conf/Nest_config.json"]

# labels for the container
LABEL org.opencontainers.image.title="Nest_accfactory"
LABEL org.opencontainers.image.description="HomeKit integration for Nest devices based on HAP-NodeJS library"
LABEL org.opencontainers.image.url="https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/tree/main/src/docker-standalone"
LABEL org.opencontainers.image.authors="mark@n0rt0nthec4t.dev"
LABEL org.opencontainers.image.version=${NEST_ACCFACTORY_VERSION}
