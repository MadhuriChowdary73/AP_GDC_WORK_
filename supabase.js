const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabaseBucket = process.env.SUPABASE_BUCKET || 'documents';

const isConfigured = Boolean(supabaseUrl && supabaseKey);

let supabase = null;
if (isConfigured) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  console.log('[Storage] Supabase client initialized with bucket:', supabaseBucket);
} else {
  console.log('[Storage] Supabase credentials not found. Falling back to local SQLite & /uploads directory.');
}

module.exports = {
  supabase,
  isConfigured,
  supabaseBucket
};
