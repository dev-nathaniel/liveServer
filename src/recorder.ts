import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { Router, Producer, PlainTransport, Consumer } from 'mediasoup/node/lib/types';
import { uploadFile } from './gcp';
import axios from 'axios';

let nextPort = 50000;

export interface RecordSession {
  id: string;
  userId: string;
  eventId: string; // Added eventId
  transport: PlainTransport;
  consumer: Consumer;
  process: ChildProcess;
  sdpPath: string;
  mediaPath: string;
  bucketName: string;
}

const activeRecordings = new Map<string, RecordSession>();

export async function startRecording(router: Router, producer: Producer, userId: string, bucketName: string, eventId: string): Promise<RecordSession> {
  const audioPort = nextPort;
  nextPort += 2; // Jump by 2 for RTCP mapping safety

  const transport = await router.createPlainTransport({
    listenIp: '127.0.0.1',
    rtcpMux: false,
    comedia: false
  });

  await transport.connect({ 
    ip: '127.0.0.1', 
    port: audioPort,
    rtcpPort: audioPort + 1
  });

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true
  });

  const pt = consumer.rtpParameters.codecs[0].payloadType;
  const sessionId = consumer.id;
  const sdpPath = `/tmp/record_${sessionId}.sdp`;
  const mediaPath = `/tmp/record_${sessionId}.m4a`;

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
    '-c:a', 'aac',    // Encode using Advanced Audio Codec (AAC)
    '-b:a', '64k',    // 64kbps is excellent quality for voice 
    '-y',
    mediaPath
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.on('error', (err) => console.error(`FFmpeg error [${userId}]:`, err));
  
  const session: RecordSession = {
    id: sessionId,
    userId,
    eventId, // Store eventId
    transport,
    consumer,
    process: ffmpegProcess,
    sdpPath,
    mediaPath,
    bucketName
  };

  activeRecordings.set(userId, session);
  await consumer.resume();

  console.log(`Recording started for ${userId} (event ${eventId}) on port ${audioPort}`);
  return session;
}

export async function stopRecording(userId: string) {
  const session = activeRecordings.get(userId);
  if (!session) return;

  activeRecordings.delete(userId);

  session.consumer.close();
  session.transport.close();
  console.log(`Stopping recording for ${userId}... Finalizing m4a.`);

  // Graceful kill allows FFmpeg to finalize the m4a container headers
  session.process.kill('SIGINT');

  session.process.on('close', async (code) => {
    console.log(`FFmpeg closed for ${userId} with code ${code}, starting GCS upload...`);
    
    // Upload the file
    if (fs.existsSync(session.mediaPath)) {
      const destination = `liveServer/recordings/${userId}_${Date.now()}.m4a`;
      const bucketName = session.bucketName;
      
      try {
        const cloudUrl = await uploadFile(session.mediaPath, destination, bucketName, true);
        if (!cloudUrl) {
          throw new Error('GCS Upload failed to return a URL');
        }
        
        console.log(`[RECORDER] Uploaded to GCS: ${destination}`);

        // Notify main backend
        const mainBackendUrl = process.env.MAIN_BACKEND_URL || 'http://localhost:8000';
        const recordingUrl = cloudUrl;
        
        // Find the event ID - we might need to store it in the session
        // For now, let's assume session.id is related or we need to pass it
        // Looking at LiveServerContext,roomId is used as currentChannel
        // Let's check how to get eventId. 
        // I'll add eventId to RecordSession.
        
        const eventId = (session as any).eventId; 
        if (eventId) {
            await axios.post(`${mainBackendUrl}/api/stream/liveserver/recording-finished`, {
                eventId,
                userId,
                recordingUrl
            });
            console.log(`[RECORDER] Notified main backend for event ${eventId}`);
        }

      } catch (err) {
        console.error(`[RECORDER] Error during upload/notification:`, err);
      } finally {
        fs.unlinkSync(session.mediaPath);
      }
    }

    if (fs.existsSync(session.sdpPath)) {
      fs.unlinkSync(session.sdpPath);
    }
  });
}
