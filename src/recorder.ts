import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { Router, Producer, PlainTransport, Consumer } from 'mediasoup/node/lib/types';
import { uploadFile } from './gcp';

let nextPort = 50000;

export interface RecordSession {
  id: string;
  userId: string;
  transport: PlainTransport;
  consumer: Consumer;
  process: ChildProcess;
  sdpPath: string;
  mediaPath: string;
  bucketName: string;
}

const activeRecordings = new Map<string, RecordSession>();

export async function startRecording(router: Router, producer: Producer, userId: string, bucketName: string): Promise<RecordSession> {
  const audioPort = nextPort;
  nextPort += 2; // Jump by 2 for RTCP mapping safety

  const transport = await router.createPlainTransport({
    listenIp: '127.0.0.1',
    rtcpMux: false,
    comedia: false
  });

  await transport.connect({ ip: '127.0.0.1', port: audioPort });

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true
  });

  const pt = consumer.rtpParameters.codecs[0].payloadType;
  const sessionId = consumer.id;
  const sdpPath = `/tmp/record_${sessionId}.sdp`;
  const mediaPath = `/tmp/record_${sessionId}.webm`;

  const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup Recording
c=IN IP4 127.0.0.1
t=0 0
m=audio ${audioPort} RTP/AVP ${pt}
a=rtpmap:${pt} opus/48000/2
`;

  fs.writeFileSync(sdpPath, sdpContent);

  const ffmpegArgs = [
    '-protocol_whitelist', 'file,udp,rtp',
    '-i', sdpPath,
    '-c:a', 'copy',
    '-y',
    mediaPath
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.on('error', (err) => console.error(`FFmpeg error [${userId}]:`, err));
  
  const session: RecordSession = {
    id: sessionId,
    userId,
    transport,
    consumer,
    process: ffmpegProcess,
    sdpPath,
    mediaPath,
    bucketName
  };

  activeRecordings.set(userId, session);
  await consumer.resume();

  console.log(`Recording started for ${userId} on port ${audioPort}`);
  return session;
}

export async function stopRecording(userId: string) {
  const session = activeRecordings.get(userId);
  if (!session) return;

  activeRecordings.delete(userId);

  session.consumer.close();
  session.transport.close();
  console.log(`Stopping recording for ${userId}... Finalizing webm.`);

  // Graceful kill allows FFmpeg to finalize the webm container headers
  session.process.kill('SIGINT');

  session.process.on('close', async (code) => {
    console.log(`FFmpeg closed for ${userId} with code ${code}, starting GCS upload...`);
    
    // Upload the file
    if (fs.existsSync(session.mediaPath)) {
      const destination = `liveServer/recordings/${userId}_${Date.now()}.webm`;
      await uploadFile(session.mediaPath, destination, session.bucketName);

      fs.unlinkSync(session.mediaPath);
    }

    if (fs.existsSync(session.sdpPath)) {
      fs.unlinkSync(session.sdpPath);
    }
  });
}
