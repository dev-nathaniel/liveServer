import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { Router, Producer, PlainTransport, Consumer } from 'mediasoup/node/lib/types';
import { uploadFile } from './gcp';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

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
  channelName: string;
}

const activeRecordings = new Map<string, RecordSession>();

export async function startRecording(router: Router, producer: Producer, socketId: string, userId: string, bucketName: string, eventId: string, channelName: string): Promise<RecordSession> {
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

  // Actively consume the stream so the buffer doesn't fill up
  ffmpegProcess.stderr.on('data', (data) => {
    // You can comment this console.log out in production, 
    // but the empty function prevents the buffer overflow.
    console.log(`FFMPEG: ${data.toString()}`); 
  });


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
    bucketName,
    channelName
  };
  console.log(`Session recording initialized for session ID: ${session.id}`);
  activeRecordings.set(userId, session);
  console.log(`Updated active recordings map: currently ${activeRecordings.size} active sessions.`);
  await consumer.resume();

  console.log(`Recording started for ${userId} (event ${eventId}) on port ${audioPort}`);
  return session;
}

export async function stopRecording(userId: string) {
  console.log(`[RECORDER] stopRecording called for user ${userId}`, JSON.stringify(activeRecordings));
  const session = activeRecordings.get(userId);
  console.log(`Checking for active session for user ${userId}: ${session ? 'Found session ' + session.id : 'No session found'}`);
  if (!session) return;

  activeRecordings.delete(userId);

  session.consumer.close();
  session.transport.close();
  console.log(`Stopping recording for ${userId}... Finalizing m4a.`);

  session.process.on('close', async (code) => {
    console.log(`FFmpeg closed for ${userId} with code ${code}, starting GCS upload...`);
    
    // Upload the file
    if (fs.existsSync(session.mediaPath)) {
      try {
        const timestamp = Date.now();
        const safeChannelName = session.channelName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const destination = `liveServer/recordings/${safeChannelName}_${userId}_${timestamp}.m4a`;
        const bucketName = session.bucketName;

        // Get actual duration using ffprobe
        let actualDuration = 0;
        try {
          const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${session.mediaPath}"`);
          actualDuration = parseFloat(stdout.trim());
          console.log(`[RECORDER] Actual duration for ${userId}: ${actualDuration}s`);
        } catch (durationErr) {
          console.error(`[RECORDER] Error getting duration:`, durationErr);
        }

        const size = fs.existsSync(session.mediaPath) ? fs.statSync(session.mediaPath).size : 0;

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
        
        const eventId = session.eventId; 
        if (eventId) {
            await axios.post(`${mainBackendUrl}/api/stream/liveserver/recording-finished`, {
                eventId,
                userId,
                recordingUrl,
                duration: actualDuration, // Send the actual duration
                size // Send the actual size
            });
            console.log(`[RECORDER] Notified main backend for event ${eventId} (Duration: ${actualDuration}s, Size: ${size} bytes)`);
        }
      } catch (err) {
        console.error(`[RECORDER] Error during upload/notification:`, err);
      } finally {
        if (fs.existsSync(session.mediaPath)) {
          fs.unlinkSync(session.mediaPath);
        }
      }
    }

    if (fs.existsSync(session.sdpPath)) {
      fs.unlinkSync(session.sdpPath);
    }
  });

  // Graceful kill allows FFmpeg to finalize the m4a container headers
  session.process.kill('SIGINT');

  
}
