// Exercise the installed Werift implementation over loopback, without camera or cloud access.
// Check bundled H264/Opus negotiation, media in both directions, DataChannel and asynchronous teardown.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { Event, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, useAudioLevelIndication } from 'werift';

function peer() {
  return new RTCPeerConnection({
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceServers: [],
    iceUseDefaultStunServer: false,
    iceInterfaceAddresses: { udp4: '127.0.0.1' },
    bundlePolicy: 'max-bundle',
    filterProbePaddingOnReceiveRtp: true,
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          payloadType: 111,
          rtcpFeedback: [{ type: 'nack' }],
          parameters: 'minptime=10;useinbandfec=1',
        }),
      ],
      video: [
        new RTCRtpCodecParameters({
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: 98,
          rtcpFeedback: [{ type: 'ccm', parameter: 'fir' }, { type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
          parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        }),
        new RTCRtpCodecParameters({ mimeType: 'video/rtx', clockRate: 90000, payloadType: 99, parameters: 'apt=98' }),
      ],
    },
    headerExtensions: { audio: [useAudioLevelIndication()] },
  });
}

test('installed Werift negotiates camera codecs and closes its loopback transports', { timeout: 15000 }, async (context) => {
  let local = peer();
  let remote = peer();
  context.after(async () => {
    await Promise.all([local.close(), remote.close()]);
  });
  let received = new Event();
  let talkback = new Event();
  let messages = new Event();
  local.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => received.execute(track.kind, packet)));
  remote.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => talkback.execute(track.kind, packet)));
  remote.onDataChannel.subscribe((channel) => channel.onMessage.subscribe((message) => messages.execute(message)));
  let channel = local.createDataChannel('webrtc-datachannel');
  let audio = local.addTransceiver('audio', { direction: 'sendrecv' });
  local.addTransceiver('video', { direction: 'recvonly' });
  await local.setLocalDescription(await local.createOffer());
  assert.match(local.localDescription.sdp, /a=rtpmap:98 H264\/90000/);
  assert.match(local.localDescription.sdp, /a=rtpmap:111 opus\/48000\/2/);
  remote.addTransceiver('audio', { direction: 'sendrecv' });
  remote.addTransceiver('video', { direction: 'sendonly' });
  await remote.setRemoteDescription(local.localDescription);
  await remote.setLocalDescription(await remote.createAnswer());
  await local.setRemoteDescription(remote.localDescription);
  await Promise.all(
    [local, remote].map((connection) =>
      connection.connectionState === 'connected'
        ? undefined
        : connection.connectionStateChange.watch((state) => state === 'connected', 5000),
    ),
  );
  if (channel.readyState !== 'open') {
    await channel.stateChanged.watch((state) => state === 'open', 5000);
  }
  let message = messages.asPromise(3000);
  channel.send('camera-fixture');
  assert.deepEqual(
    await message.catch((error) => {
      throw new Error('DataChannel delivery failed', { cause: error });
    }),
    ['camera-fixture'],
  );

  let incomingVideo = received.watch((kind) => kind === 'video', 3000);
  let videoPayload = Buffer.from([0x65, 1, 2, 3]);
  let video = remote.getTransceivers().find((transceiver) => transceiver.kind === 'video');
  await video.sender.sendRtp(
    new RtpPacket(new RtpHeader({ payloadType: 98, sequenceNumber: 10, timestamp: 90000, marker: true }), videoPayload),
  );
  assert.deepEqual(
    (
      await incomingVideo.catch((error) => {
        throw new Error('H264 RTP delivery failed', { cause: error });
      })
    )[1].payload,
    videoPayload,
  );

  let incomingAudio = talkback.watch((kind) => kind === 'audio', 3000);
  let audioPayload = Buffer.from([0xf8, 0xff, 0xfe]);
  await audio.sender.sendRtp(
    new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: 20, timestamp: 48000, marker: true }), audioPayload),
  );
  assert.deepEqual(
    (
      await incomingAudio.catch((error) => {
        throw new Error('Opus talkback delivery failed', { cause: error });
      })
    )[1].payload,
    audioPayload,
  );

  await Promise.all([local.close(), remote.close()]);
  assert.equal(local.connectionState, 'closed');
  assert.equal(remote.connectionState, 'closed');
  assert.equal(
    local.iceTransports.every((transport) => transport.state === 'closed'),
    true,
  );
  assert.equal(
    remote.iceTransports.every((transport) => transport.state === 'closed'),
    true,
  );
});
