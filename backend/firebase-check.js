const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');

dotenv.config({ path: path.join(__dirname, '.env') });

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }
  try {
    return require('./serviceAccountKey.json');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new Error('Firebase credentials are missing.');
    }
    throw error;
  }
}

async function checkFirebase() {
  let app;
  try {
    const serviceAccount = loadServiceAccount();
    const bucketNames = [...new Set([
      process.env.FIREBASE_STORAGE_BUCKET,
      `${serviceAccount.project_id}.firebasestorage.app`,
      `${serviceAccount.project_id}.appspot.com`
    ].filter(Boolean))];
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || bucketNames[0];
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: bucketName
    }, `firebase-check-${process.pid}`);

    let visibleBuckets = [];
    let bucketListStatus = 'failed';
    try {
      const storageClient = new Storage({
        projectId: serviceAccount.project_id,
        credentials: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key }
      });
      const [buckets] = await storageClient.getBuckets({ project: serviceAccount.project_id });
      visibleBuckets = buckets.map(bucket => bucket.name);
      bucketListStatus = 'connected';
    } catch (error) {
      bucketListStatus = `failed:${error.code || error.name}`;
    }

    if (process.argv.includes('--create-storage')) {
      const region = process.env.FIREBASE_STORAGE_REGION || 'ASIA-SOUTH1';
      try {
        await admin.storage(app).bucket(bucketName).create({ location: region });
        console.log(JSON.stringify({ storageBucket: 'created', region }));
      } catch (error) {
        if (error.code !== 409) throw error;
        console.log(JSON.stringify({ storageBucket: 'already-exists', region }));
      }
    }

    const firestoreDb = admin.firestore(app);
    const storageBucket = admin.storage(app).bucket(bucketName);
    const checkId = crypto.randomUUID();
    const testDocument = firestoreDb.collection('_temporaryConnectionChecks').doc(checkId);
    let firestoreStatus = 'failed';
    try {
      await testDocument.create({ createdAt: Date.now(), checkId });
      const snapshot = await testDocument.get();
      if (!snapshot.exists || snapshot.data().checkId !== checkId) throw new Error('Firestore verification mismatch.');
      firestoreStatus = 'connected:write-read-delete';
    } catch (error) {
      firestoreStatus = `failed:${error.code || error.name}`;
    } finally {
      await testDocument.delete().catch(() => {});
    }

    const storageResults = await Promise.allSettled(bucketNames.map(name => admin.storage(app).bucket(name).getMetadata()));
    const storageUploadTest = process.argv.includes('--upload-test');
    let storageUploadStatus = storageUploadTest ? 'not-tested' : 'skipped';
    if (storageUploadTest) {
      const objectName = `tmp/connection-checks/${checkId}.txt`;
      const file = storageBucket.file(objectName);
      const probe = Buffer.from(`Temporary Firebase Storage connectivity check ${checkId}`);
      try {
        await file.save(probe, { resumable: false, metadata: { contentType: 'text/plain' } });
        const [downloaded] = await file.download();
        if (!downloaded.equals(probe)) throw new Error('Storage verification mismatch.');
        storageUploadStatus = 'connected:upload-download-delete';
      } catch (error) {
        storageUploadStatus = `failed:${error.code || error.name}`;
      } finally {
        await file.delete({ ignoreNotFound: true }).catch(() => {});
      }
    }

    let sheetsStatus = 'failed';
    try {
      const auth = new google.auth.GoogleAuth({
        credentials: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      const sheets = google.sheets({ version: 'v4', auth });
      await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID || '1RZNZEuxiO81zaew3mG40iySFi_ixX0EY0lIkTEslr18', fields: 'spreadsheetId' });
      sheetsStatus = 'connected:metadata-read';
    } catch (error) {
      sheetsStatus = `failed:${error.code || error.name}`;
    }

    const result = {
      firestore: firestoreStatus,
      googleSheets: sheetsStatus,
      bucketDiscovery: bucketListStatus,
      visibleBuckets,
      storageBucket: storageResults[0].status === 'fulfilled' ? 'exists' : `failed:${storageResults[0].reason.code || storageResults[0].reason.name}`,
      storageUpload: storageUploadStatus,
      alternateStorageBuckets: Object.fromEntries(bucketNames.slice(1).map((name, index) => [
        name,
        storageResults[index + 1].status === 'fulfilled' ? 'exists' : `failed:${storageResults[index + 1].reason.code || storageResults[index + 1].reason.name}`
      ]))
    };
    console.log(JSON.stringify(result));
    if (firestoreStatus.startsWith('failed') || sheetsStatus.startsWith('failed')
      || storageResults[0].status === 'rejected' || storageUploadStatus.startsWith('failed')) process.exitCode = 1;
  } catch (error) {
    console.error(`Firebase operation failed: ${error.code || error.name}`);
    process.exitCode = 1;
  } finally {
    if (app) await app.delete();
  }
}

checkFirebase();