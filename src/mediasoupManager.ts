import * as mediasoup from 'mediasoup';
import { Worker, Router, WebRtcTransport } from 'mediasoup/node/lib/types';
import { config } from './config';

let workers: Worker[] = [];
let nextMediasoupWorkerIdx = 0;

export async function createWorkers() {
  const { numWorkers } = config.mediasoup;
  console.log(`Creating ${numWorkers} mediasoup workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error(`mediasoup worker died, exiting in 2 seconds... [pid:${worker.pid}]`);
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
  }
}

export function getMediasoupWorker(): Worker {
  const worker = workers[nextMediasoupWorkerIdx];
  if (++nextMediasoupWorkerIdx === workers.length) {
    nextMediasoupWorkerIdx = 0;
  }
  return worker;
}

export async function createRouter(): Promise<Router> {
  const worker = getMediasoupWorker();
  return await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
}

export async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  const {
    listenIps,
    enableUdp,
    enableTcp,
    preferUdp,
  } = config.mediasoup.webRtcTransport;

  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp,
    enableTcp,
    preferUdp,
  });

  transport.on('dtlsstatechange', dtlsState => {
    if (dtlsState === 'closed' || dtlsState === 'failed') {
      transport.close();
    }
  });

  return transport;
}
