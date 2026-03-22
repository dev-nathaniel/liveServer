import { WorkerSettings, RtpCodecCapability, WebRtcTransportOptions } from 'mediasoup/node/lib/types';

export const config = {
  listenIp: '0.0.0.0',
  listenPort: parseInt(process.env.PORT || '4000', 10),
  
  mediasoup: {
    numWorkers: Object.keys(require('os').cpus()).length,
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: 'warn' as const,
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'] as const,
    } as WorkerSettings,
    
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2
        }
      ] as RtpCodecCapability[]
    },
    
    webRtcTransport: {
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1'
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    } as Omit<WebRtcTransportOptions, 'listenIps'> & { listenIps: Array<{ip: string, announcedIp?: string}> }
  }
};
