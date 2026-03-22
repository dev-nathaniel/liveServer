import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';

let storage: Storage | null = null;
const keyPath = path.join(process.cwd(), 'google-credentials.json');

if (fs.existsSync(keyPath)) {
  storage = new Storage({ keyFilename: keyPath });
} else {
  console.warn("WARNING: google-credentials.json not found. GCS Uploads will be skipped.");
}

// export const bucketName = process.env.GCS_BUCKET_NAME || 'my-live-recordings';

export async function uploadFile(filePath: string, destination: string, bucketName: string) {
  if (!storage) {
    console.warn(`[GCS SKIP] Would have uploaded ${filePath} to gs://${bucketName}/${destination}`);
    return;
  }
  
  try {
    await storage.bucket(bucketName).upload(filePath, {
      destination,
      metadata: { contentType: 'audio/webm' },
    });
    console.log(`Uploaded ${filePath} to ${bucketName}/${destination}`);
  } catch (error) {
    console.error('GCS Upload error:', error);
  }
}
