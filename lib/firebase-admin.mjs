import admin from 'firebase-admin'

/**
 * @returns {object|null}
 */
export function getServiceAccountFromEnv() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  try {
    if (b64?.trim()) {
      const decoded = Buffer.from(b64.trim(), 'base64').toString('utf8')
      return JSON.parse(decoded)
    }
    if (raw?.trim()) {
      return JSON.parse(raw.trim())
    }
  } catch (e) {
    console.error('Invalid Firebase service account env:', e.message)
  }
  return null
}

/**
 * @returns {import('firebase-admin').app.App|null}
 */
export function getAdminApp() {
  if (admin.apps.length) {
    return admin.app()
  }
  const cred = getServiceAccountFromEnv()
  if (!cred?.project_id || !cred?.private_key || !cred?.client_email) {
    return null
  }
  admin.initializeApp({
    credential: admin.credential.cert(cred),
  })
  return admin.app()
}

/**
 * @returns {import('firebase-admin/firestore').Firestore|null}
 */
export function getAdminFirestore() {
  const app = getAdminApp()
  if (!app) return null
  return admin.firestore()
}
