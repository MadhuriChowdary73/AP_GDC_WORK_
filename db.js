/**
 * Unified Database Layer
 * Automatically uses Supabase Postgres when SUPABASE_URL & SUPABASE_KEY are provided.
 * Gracefully falls back to local SQLite (library.db) when running offline / without credentials.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { supabase, isConfigured } = require('./supabase');

// Initialize local SQLite fallback
const dbPath = path.join(__dirname, 'library.db');
const sqlite = new DatabaseSync(dbPath);

sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA journal_mode = WAL;');

// Initialize tables in SQLite if they don't exist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    panel TEXT DEFAULT 'main' NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subsections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(section_id, name),
    FOREIGN KEY(section_id) REFERENCES sections(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    subsection_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(subsection_id) REFERENCES subsections(id) ON DELETE CASCADE
  );
`);

// Safe migration for SQLite
try {
  const columns = sqlite.prepare('PRAGMA table_info(sections)').all();
  const hasPanelCol = columns.some(c => c.name === 'panel');
  if (!hasPanelCol) {
    sqlite.exec(`ALTER TABLE sections ADD COLUMN panel TEXT DEFAULT 'main';`);
    sqlite.exec(`UPDATE sections SET panel = 'main' WHERE panel IS NULL OR panel = '';`);
  }
} catch (migErr) {
  console.warn('[SQLite] Migration note for sections:', migErr.message);
}

// Unified Database Adapter
const db = {
  isSupabase: isConfigured && Boolean(supabase),
  sqlite,

  // Direct prepare method for SQLite backward compatibility
  prepare(sql) {
    return sqlite.prepare(sql);
  },
  exec(sql) {
    return sqlite.exec(sql);
  },

  // --- ADMINS ---
  admins: {
    async findByUsername(username) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('admins')
          .select('*')
          .eq('username', username.trim())
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      }
      return sqlite.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());
    },

    async findById(id) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('admins')
          .select('*')
          .eq('id', id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      }
      return sqlite.prepare('SELECT * FROM admins WHERE id = ?').get(id);
    },

    async create({ username, password_hash }) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('admins')
          .insert({ username: username.trim(), password_hash })
          .select()
          .single();
        if (error) throw new Error(error.message);
        return data;
      }
      const res = sqlite.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username.trim(), password_hash);
      return { id: res.lastInsertRowid, username, password_hash };
    },

    async updatePassword(username, password_hash) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('admins')
          .update({ password_hash })
          .eq('username', username.trim())
          .select();
        if (error) throw new Error(error.message);
        return data && data.length > 0;
      }
      const res = sqlite.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(password_hash, username.trim());
      return res.changes > 0;
    },

    async count() {
      if (db.isSupabase) {
        const { count, error } = await supabase
          .from('admins')
          .select('*', { count: 'exact', head: true });
        if (error) throw new Error(error.message);
        return count || 0;
      }
      const row = sqlite.prepare('SELECT COUNT(*) AS total FROM admins').get();
      return row ? row.total : 0;
    }
  },

  // --- SECTIONS ---
  sections: {
    async getAll(panel = null) {
      if (db.isSupabase) {
        let query = supabase
          .from('sections')
          .select(`
            id,
            name,
            panel,
            subsections (
              id,
              documents ( id )
            )
          `)
          .order('id', { ascending: true });

        if (panel) {
          query = query.eq('panel', panel);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        return (data || []).map(s => {
          const subs = s.subsections || [];
          const subsectionCount = subs.length;
          const documentCount = subs.reduce((sum, sub) => sum + (sub.documents ? sub.documents.length : 0), 0);
          return {
            id: s.id,
            name: s.name,
            panel: s.panel,
            subsection_count: subsectionCount,
            document_count: documentCount
          };
        });
      }

      let query = `
        SELECT 
          s.id, 
          s.name,
          s.panel,
          (SELECT COUNT(*) FROM subsections sub WHERE sub.section_id = s.id) AS subsection_count,
          (SELECT COUNT(*) FROM documents d 
           JOIN subsections sub ON d.subsection_id = sub.id 
           WHERE sub.section_id = s.id) AS document_count
        FROM sections s
      `;
      const params = [];
      if (panel) {
        query += ` WHERE s.panel = ?`;
        params.push(panel);
      }
      query += ` ORDER BY s.id ASC`;
      return sqlite.prepare(query).all(...params);
    },

    async getById(id) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('sections')
          .select('id, name, panel')
          .eq('id', id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      }
      return sqlite.prepare('SELECT id, name, panel FROM sections WHERE id = ?').get(id);
    },

    async findByNameAndPanel(name, panel, excludeId = null) {
      if (db.isSupabase) {
        let query = supabase
          .from('sections')
          .select('id, name, panel')
          .ilike('name', name.trim())
          .eq('panel', panel);
        if (excludeId) {
          query = query.neq('id', excludeId);
        }
        const { data, error } = await query.maybeSingle();
        if (error && error.code !== 'PGRST116') throw new Error(error.message);
        return data;
      }
      let sql = 'SELECT id FROM sections WHERE LOWER(name) = LOWER(?) AND panel = ?';
      const params = [name.trim(), panel];
      if (excludeId) {
        sql += ' AND id != ?';
        params.push(excludeId);
      }
      return sqlite.prepare(sql).get(...params);
    },

    async create({ name, panel = 'main' }) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('sections')
          .insert({ name: name.trim(), panel })
          .select()
          .single();
        if (error) throw new Error(error.message);
        return {
          id: data.id,
          name: data.name,
          panel: data.panel,
          subsection_count: 0,
          document_count: 0
        };
      }
      const res = sqlite.prepare('INSERT INTO sections (name, panel) VALUES (?, ?)').run(name.trim(), panel);
      return {
        id: res.lastInsertRowid,
        name: name.trim(),
        panel,
        subsection_count: 0,
        document_count: 0
      };
    },

    async update(id, { name, panel }) {
      if (db.isSupabase) {
        const updates = {};
        if (name) updates.name = name.trim();
        if (panel) updates.panel = panel;
        const { data, error } = await supabase
          .from('sections')
          .update(updates)
          .eq('id', id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        return data;
      }
      sqlite.prepare('UPDATE sections SET name = ?, panel = ? WHERE id = ?').run(name.trim(), panel, id);
      return sqlite.prepare('SELECT id, name, panel FROM sections WHERE id = ?').get(id);
    },

    async delete(id) {
      if (db.isSupabase) {
        const { error } = await supabase
          .from('sections')
          .delete()
          .eq('id', id);
        if (error) throw new Error(error.message);
        return true;
      }
      sqlite.prepare('DELETE FROM sections WHERE id = ?').run(id);
      return true;
    },

    async count() {
      if (db.isSupabase) {
        const { count, error } = await supabase
          .from('sections')
          .select('*', { count: 'exact', head: true });
        if (error) throw new Error(error.message);
        return count || 0;
      }
      const row = sqlite.prepare('SELECT COUNT(*) AS total FROM sections').get();
      return row ? row.total : 0;
    },

    async getSubsections(sectionId) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('subsections')
          .select(`
            id,
            name,
            section_id,
            documents ( id )
          `)
          .eq('section_id', sectionId)
          .order('id', { ascending: true });
        if (error) throw new Error(error.message);

        return (data || []).map(sub => ({
          id: sub.id,
          name: sub.name,
          section_id: sub.section_id,
          document_count: sub.documents ? sub.documents.length : 0
        }));
      }

      return sqlite.prepare(`
        SELECT 
          sub.id, 
          sub.name, 
          sub.section_id,
          (SELECT COUNT(*) FROM documents d WHERE d.subsection_id = sub.id) AS document_count
        FROM subsections sub
        WHERE sub.section_id = ?
        ORDER BY sub.id ASC
      `).all(sectionId);
    }
  },

  // --- SUBSECTIONS ---
  subsections: {
    async getAll(sectionId = null) {
      if (db.isSupabase) {
        let query = supabase
          .from('subsections')
          .select(`
            id,
            name,
            section_id,
            sections ( id, name, panel ),
            documents ( id )
          `)
          .order('id', { ascending: true });

        if (sectionId) {
          query = query.eq('section_id', sectionId);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        return (data || []).map(sub => ({
          id: sub.id,
          name: sub.name,
          section_id: sub.section_id,
          section_name: sub.sections ? sub.sections.name : '',
          panel: sub.sections ? sub.sections.panel : 'main',
          document_count: sub.documents ? sub.documents.length : 0
        }));
      }

      let query = `
        SELECT 
          sub.id, 
          sub.name, 
          sub.section_id,
          s.name AS section_name,
          s.panel,
          (SELECT COUNT(*) FROM documents d WHERE d.subsection_id = sub.id) AS document_count
        FROM subsections sub
        JOIN sections s ON sub.section_id = s.id
      `;
      const params = [];
      if (sectionId) {
        query += ` WHERE sub.section_id = ?`;
        params.push(sectionId);
      }
      query += ` ORDER BY sub.id ASC`;
      return sqlite.prepare(query).all(...params);
    },

    async getById(id) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('subsections')
          .select(`
            id,
            name,
            section_id,
            sections ( id, name, panel )
          `)
          .eq('id', id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return null;
        return {
          id: data.id,
          name: data.name,
          section_id: data.section_id,
          section_name: data.sections ? data.sections.name : '',
          panel: data.sections ? data.sections.panel : 'main'
        };
      }
      return sqlite.prepare(`
        SELECT sub.*, s.name AS section_name, s.panel
        FROM subsections sub
        JOIN sections s ON sub.section_id = s.id
        WHERE sub.id = ?
      `).get(id);
    },

    async findBySectionAndName(sectionId, name, excludeId = null) {
      if (db.isSupabase) {
        let query = supabase
          .from('subsections')
          .select('id, name, section_id')
          .eq('section_id', sectionId)
          .ilike('name', name.trim());
        if (excludeId) {
          query = query.neq('id', excludeId);
        }
        const { data, error } = await query.maybeSingle();
        if (error && error.code !== 'PGRST116') throw new Error(error.message);
        return data;
      }
      let sql = 'SELECT id FROM subsections WHERE section_id = ? AND LOWER(name) = LOWER(?)';
      const params = [sectionId, name.trim()];
      if (excludeId) {
        sql += ' AND id != ?';
        params.push(excludeId);
      }
      return sqlite.prepare(sql).get(...params);
    },

    async create({ section_id, name }) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('subsections')
          .insert({ section_id, name: name.trim() })
          .select(`
            id,
            name,
            section_id,
            sections ( id, name, panel )
          `)
          .single();
        if (error) throw new Error(error.message);
        return {
          id: data.id,
          name: data.name,
          section_id: data.section_id,
          section_name: data.sections ? data.sections.name : '',
          panel: data.sections ? data.sections.panel : 'main',
          document_count: 0
        };
      }
      const res = sqlite.prepare('INSERT INTO subsections (section_id, name) VALUES (?, ?)').run(section_id, name.trim());
      const section = sqlite.prepare('SELECT name, panel FROM sections WHERE id = ?').get(section_id);
      return {
        id: res.lastInsertRowid,
        section_id,
        name: name.trim(),
        section_name: section ? section.name : '',
        panel: section ? section.panel : 'main',
        document_count: 0
      };
    },

    async update(id, { name, section_id }) {
      if (db.isSupabase) {
        const updates = {};
        if (name) updates.name = name.trim();
        if (section_id) updates.section_id = section_id;
        const { data, error } = await supabase
          .from('subsections')
          .update(updates)
          .eq('id', id)
          .select(`
            id,
            name,
            section_id,
            sections ( id, name, panel )
          `)
          .single();
        if (error) throw new Error(error.message);
        return {
          id: data.id,
          name: data.name,
          section_id: data.section_id,
          section_name: data.sections ? data.sections.name : '',
          panel: data.sections ? data.sections.panel : 'main'
        };
      }
      sqlite.prepare('UPDATE subsections SET name = ?, section_id = ? WHERE id = ?').run(name.trim(), section_id, id);
      return this.getById(id);
    },

    async delete(id) {
      if (db.isSupabase) {
        const { error } = await supabase
          .from('subsections')
          .delete()
          .eq('id', id);
        if (error) throw new Error(error.message);
        return true;
      }
      sqlite.prepare('DELETE FROM subsections WHERE id = ?').run(id);
      return true;
    }
  },

  // --- DOCUMENTS ---
  documents: {
    async getAll({ section_id = '', subsection_id = '', search = '' } = {}) {
      if (db.isSupabase) {
        let query = supabase
          .from('documents')
          .select(`
            id,
            title,
            description,
            file_path,
            file_size,
            uploaded_at,
            subsection_id,
            subsections!inner (
              id,
              name,
              section_id,
              sections!inner (
                id,
                name
              )
            )
          `)
          .order('uploaded_at', { ascending: false });

        if (subsection_id && subsection_id !== 'all' && subsection_id !== '') {
          query = query.eq('subsection_id', subsection_id);
        } else if (section_id && section_id !== 'all' && section_id !== '') {
          query = query.eq('subsections.section_id', section_id);
        }

        if (search && search.trim()) {
          const s = search.trim();
          query = query.or(`title.ilike.%${s}%,description.ilike.%${s}%`);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        return (data || []).map(d => ({
          id: d.id,
          title: d.title,
          description: d.description || '',
          file_path: d.file_path,
          file_size: d.file_size || 0,
          uploaded_at: d.uploaded_at,
          subsection_id: d.subsections ? d.subsections.id : d.subsection_id,
          subsection_name: d.subsections ? d.subsections.name : '',
          section_id: d.subsections && d.subsections.sections ? d.subsections.sections.id : '',
          section_name: d.subsections && d.subsections.sections ? d.subsections.sections.name : ''
        }));
      }

      let query = `
        SELECT 
          d.id,
          d.title,
          d.description,
          d.file_path,
          d.file_size,
          d.uploaded_at,
          sub.id AS subsection_id,
          sub.name AS subsection_name,
          s.id AS section_id,
          s.name AS section_name
        FROM documents d
        JOIN subsections sub ON d.subsection_id = sub.id
        JOIN sections s ON sub.section_id = s.id
        WHERE 1=1
      `;
      const params = [];

      if (subsection_id && subsection_id !== 'all' && subsection_id !== '') {
        query += ' AND d.subsection_id = ?';
        params.push(subsection_id);
      } else if (section_id && section_id !== 'all' && section_id !== '') {
        query += ' AND sub.section_id = ?';
        params.push(section_id);
      }

      if (search && search.trim()) {
        const term = `%${search.trim().toLowerCase()}%`;
        query += ' AND (LOWER(d.title) LIKE ? OR LOWER(d.description) LIKE ?)';
        params.push(term, term);
      }

      query += ' ORDER BY d.uploaded_at DESC, d.id DESC';
      return sqlite.prepare(query).all(...params);
    },

    async getById(id) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('documents')
          .select(`
            id,
            title,
            description,
            file_path,
            file_size,
            uploaded_at,
            subsection_id,
            subsections (
              id,
              name,
              sections (
                id,
                name
              )
            )
          `)
          .eq('id', id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return null;

        return {
          id: data.id,
          title: data.title,
          description: data.description || '',
          file_path: data.file_path,
          file_size: data.file_size || 0,
          uploaded_at: data.uploaded_at,
          subsection_id: data.subsections ? data.subsections.id : data.subsection_id,
          subsection_name: data.subsections ? data.subsections.name : '',
          section_id: data.subsections && data.subsections.sections ? data.subsections.sections.id : '',
          section_name: data.subsections && data.subsections.sections ? data.subsections.sections.name : ''
        };
      }

      return sqlite.prepare(`
        SELECT 
          d.id,
          d.title,
          d.description,
          d.file_path,
          d.file_size,
          d.uploaded_at,
          sub.id AS subsection_id,
          sub.name AS subsection_name,
          s.id AS section_id,
          s.name AS section_name
        FROM documents d
        JOIN subsections sub ON d.subsection_id = sub.id
        JOIN sections s ON sub.section_id = s.id
        WHERE d.id = ?
      `).get(id);
    },

    async create({ title, description = '', subsection_id, file_path, file_size = 0 }) {
      if (db.isSupabase) {
        const { data, error } = await supabase
          .from('documents')
          .insert({
            title: title.trim(),
            description: (description || '').trim(),
            subsection_id,
            file_path,
            file_size
          })
          .select()
          .single();
        if (error) throw new Error(error.message);
        return this.getById(data.id);
      }

      const res = sqlite.prepare(`
        INSERT INTO documents (title, description, subsection_id, file_path, file_size)
        VALUES (?, ?, ?, ?, ?)
      `).run(title.trim(), (description || '').trim(), subsection_id, file_path, file_size);

      return this.getById(res.lastInsertRowid);
    },

    async update(id, { title, description, subsection_id, file_path, file_size }) {
      if (db.isSupabase) {
        const updates = {};
        if (title !== undefined) updates.title = title.trim();
        if (description !== undefined) updates.description = (description || '').trim();
        if (subsection_id !== undefined) updates.subsection_id = subsection_id;
        if (file_path !== undefined) updates.file_path = file_path;
        if (file_size !== undefined) updates.file_size = file_size;

        const { error } = await supabase
          .from('documents')
          .update(updates)
          .eq('id', id);
        if (error) throw new Error(error.message);

        return this.getById(id);
      }

      sqlite.prepare(`
        UPDATE documents 
        SET title = ?, description = ?, subsection_id = ?, file_path = ?, file_size = ?
        WHERE id = ?
      `).run(title.trim(), (description || '').trim(), subsection_id, file_path, file_size, id);

      return this.getById(id);
    },

    async delete(id) {
      if (db.isSupabase) {
        const { error } = await supabase
          .from('documents')
          .delete()
          .eq('id', id);
        if (error) throw new Error(error.message);
        return true;
      }

      sqlite.prepare('DELETE FROM documents WHERE id = ?').run(id);
      return true;
    },

    async count() {
      if (db.isSupabase) {
        const { count, error } = await supabase
          .from('documents')
          .select('*', { count: 'exact', head: true });
        if (error) throw new Error(error.message);
        return count || 0;
      }
      const row = sqlite.prepare('SELECT COUNT(*) AS total FROM documents').get();
      return row ? row.total : 0;
    }
  }
};

module.exports = db;
