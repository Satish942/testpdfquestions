import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || ''

let _client = null

/**
 * Returns a Supabase client, or null if credentials are not configured.
 */
export function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  if (_client) return _client
  _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  })
  return _client
}
