import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';

let storage: Storage | null = null;
const keyPath = path.join(__dirname, '../google-credentials.json');

if (fs.existsSync(keyPath)) {
  storage = new Storage({ keyFilename: keyPath });
} else {
  console.warn("WARNING: google-credentials.json not found. GCS Uploads will be skipped.");
}

// export const bucketName = process.env.GCS_BUCKET_NAME || 'my-live-recordings';

export async function uploadFile(filePath: string, destination: string, bucketName: string, makePublic: boolean = false): Promise<string | undefined> {
  if (!storage) {
    console.warn(`[GCS SKIP] Would have uploaded ${filePath} to gs://${bucketName}/${destination}`);
    return;
  }
  
  try {
    const bucket = storage.bucket(bucketName);
    await bucket.upload(filePath, {
      destination,
      metadata: { contentType: 'audio/mp4' },
    });

    if (makePublic) {
      // Create a signed URL with a very long expiration (e.g., 50 years from now)
      const [url] = await bucket.file(destination).getSignedUrl({
        action: 'read',
        expires: '01-01-2076', // Year 2076 should be far enough
      });
      console.log(`Uploaded ${filePath} to ${bucketName}/${destination} and generated SIGNED URL.`);
      return url;
    }

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${destination}`;
    console.log(`Uploaded ${filePath} to ${bucketName}/${destination} (non-signed URL: ${publicUrl})`);
    return publicUrl;
  } catch (error) {
    console.error('GCS Upload error:', error);
    return undefined;
  }
}
