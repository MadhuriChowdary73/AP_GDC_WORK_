/**
 * One-Time Migration Script: Local SQLite & Files -> Supabase (Postgres & Storage)
 * 
 * Usage:
 *   SUPABASE_URL=https://xyz.supabase.co SUPABASE_KEY=your_service_role_key node migrate-to-supabase.js
 * 
 * Note: If previous uploads were already wiped on Render due to its ephemeral disk,
 * simply start fresh by uploading the real PDFs directly via the Admin panel.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const bucketName = process.env.SUPABASE_BUCKET || 'documents';

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) environment variables are required.');
  console.log('Run with:');
  console.log('  node -r dotenv/config migrate-to-supabase.js (if using .env)');
  console.log('or set the environment variables before running.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const dbPath = path.join(__dirname, 'library.db');

if (!fs.existsSync(dbPath)) {
  console.log('No local library.db found. Nothing to migrate.');
  process.exit(0);
}

const sqlite = new DatabaseSync(dbPath);

async function migrate() {
  console.log('Starting migration to Supabase...');

  // 1. Ensure bucket exists
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = buckets && buckets.some(b => b.name === bucketName);
    if (!exists) {
      console.log(`Creating bucket "${bucketName}"...`);
      await supabase.storage.createBucket(bucketName, { public: true });
    }
  } catch (err) {
    console.warn('Note on bucket check:', err.message);
  }

  // 2. Migrate Admins
  const localAdmins = sqlite.prepare('SELECT * FROM admins').all();
  console.log(`Found ${localAdmins.length} local admin(s).`);
  for (const admin of localAdmins) {
    const { data: existing } = await supabase.from('admins').select('id').eq('username', admin.username).maybeSingle();
    if (!existing) {
      await supabase.from('admins').insert({
        username: admin.username,
        password_hash: admin.password_hash
      });
      console.log(`  Migrated admin: ${admin.username}`);
    }
  }

  // 3. Migrate Sections
  const localSections = sqlite.prepare('SELECT * FROM sections').all();
  const sectionIdMap = new Map();
  for (const sec of localSections) {
    const { data: existing } = await supabase.from('sections')
      .select('id')
      .eq('name', sec.name)
      .eq('panel', sec.panel || 'main')
      .maybeSingle();

    if (existing) {
      sectionIdMap.set(sec.id, existing.id);
    } else {
      const { data: inserted, error } = await supabase.from('sections').insert({
        name: sec.name,
        panel: sec.panel || 'main'
      }).select().single();
      if (!error && inserted) {
        sectionIdMap.set(sec.id, inserted.id);
        console.log(`  Migrated section: ${sec.name} (${sec.panel || 'main'})`);
      }
    }
  }

  // 4. Migrate Subsections
  const localSubsections = sqlite.prepare('SELECT * FROM subsections').all();
  const subIdMap = new Map();
  for (const sub of localSubsections) {
    const remoteSectionId = sectionIdMap.get(sub.section_id);
    if (!remoteSectionId) continue;

    const { data: existing } = await supabase.from('subsections')
      .select('id')
      .eq('section_id', remoteSectionId)
      .eq('name', sub.name)
      .maybeSingle();

    if (existing) {
      subIdMap.set(sub.id, existing.id);
    } else {
      const { data: inserted, error } = await supabase.from('subsections').insert({
        section_id: remoteSectionId,
        name: sub.name
      }).select().single();
      if (!error && inserted) {
        subIdMap.set(sub.id, inserted.id);
        console.log(`  Migrated subsection: ${sub.name}`);
      }
    }
  }

  // 5. Migrate Documents & Physical Files
  const localDocs = sqlite.prepare('SELECT * FROM documents').all();
  console.log(`Found ${localDocs.length} local document record(s).`);

  let uploadedCount = 0;
  for (const doc of localDocs) {
    const remoteSubId = subIdMap.get(doc.subsection_id);
    if (!remoteSubId) {
      console.warn(`  Skipping document "${doc.title}": parent subsection mapping not found.`);
      continue;
    }

    // Resolve local file path
    const fullPath = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, doc.file_path);
    let publicUrl = doc.file_path;

    if (fs.existsSync(fullPath)) {
      const fileBuffer = fs.readFileSync(fullPath);
      const filename = `migrated_${Date.now()}_${path.basename(doc.file_path)}`;

      console.log(`  Uploading file for "${doc.title}" to Supabase Storage (${fileBuffer.length} bytes)...`);
      const { error: uploadError } = await supabase.storage.from(bucketName).upload(filename, fileBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

      if (!uploadError) {
        const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(filename);
        publicUrl = urlData.publicUrl;
      } else {
        console.warn(`    Upload failed for "${doc.title}":`, uploadError.message);
      }
    } else {
      console.warn(`  Local file not found on disk for "${doc.title}" (${doc.file_path}).`);
    }

    // Insert document record into Supabase
    const { error: docError } = await supabase.from('documents').insert({
      title: doc.title,
      description: doc.description || '',
      subsection_id: remoteSubId,
      file_path: publicUrl,
      file_size: doc.file_size || 0,
      uploaded_at: doc.uploaded_at || new Date().toISOString()
    });

    if (!docError) {
      uploadedCount++;
      console.log(`  Document migrated: "${doc.title}"`);
    } else {
      console.error(`  Failed to insert document "${doc.title}":`, docError.message);
    }
  }

  console.log(`\nMigration finished! Successfully migrated ${uploadedCount} document(s).`);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
