/**
 * Supabase Client Configuration
 * Reads credentials from environment variables:
 * - SUPABASE_URL: Project URL (e.g. https://<project>.supabase.co)
 * - SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY: Service role or Anon key
 * - SUPABASE_BUCKET: Storage bucket for PDFs (defaults to 'documents')
 */
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabaseBucket = process.env.SUPABASE_BUCKET || 'documents';

const isConfigured = Boolean(supabaseUrl && supabaseKey);

let supabase = null;

if (isConfigured) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    console.log('[Storage] Connected to external Supabase persistent backend:', supabaseUrl);
  } catch (err) {
    console.error('[Storage] Error initializing Supabase client:', err.message);
  }
} else {
  console.log('[Storage] Supabase credentials not found. Falling back to local SQLite & /uploads directory.');
}

module.exports = {
  supabase,
  isConfigured,
  supabaseBucket
};
