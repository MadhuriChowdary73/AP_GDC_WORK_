const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const storageService = require('../services/storage');
const { supabase, supabaseBucket } = require('../supabase');
const { authMiddleware } = require('../middleware/auth');

// Multer in-memory storage: nothing is written to local filesystem
const storage = multer.memoryStorage();

// PDF file filter - validates MIME type and extension
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;

  if (ext === '.pdf' && (mime === 'application/pdf' || mime === 'application/x-pdf')) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF files (.pdf) are allowed.'));
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB limit
  },
  fileFilter
});

// Helper to sanitize title for filename in Content-Disposition
function sanitizeFilename(title) {
  const clean = title.replace(/[/\\?%*:|"<>]/g, '_').trim();
  return clean || 'document';
}

// Helper to verify PDF magic bytes (%PDF) from in-memory buffer
function verifyPdfMagicBytes(bufferOrPath) {
  try {
    if (Buffer.isBuffer(bufferOrPath)) {
      if (bufferOrPath.length < 4) return false;
      return bufferOrPath.slice(0, 4).toString('utf8') === '%PDF';
    }
    const fd = fs.openSync(bufferOrPath, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    return buffer.toString('utf8') === '%PDF';
  } catch (err) {
    return false;
  }
}

// GET /api/documents - Public listing and search using Supabase
router.get('/', async (req, res) => {
  try {
    const { section_id, subsection_id, section, subsection, search } = req.query;
    const documents = await db.documents.getAll({ section_id, subsection_id, section, subsection, search });
    res.json(documents);
  } catch (err) {
    console.error('Error fetching documents from Supabase:', err);
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// GET /api/documents/:id - Single document details
router.get('/:id', async (req, res) => {
  try {
    const document = await db.documents.getById(req.params.id);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(document);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve document details' });
  }
});

// GET /api/documents/:id/download - Download PDF from Supabase with admin-given title
router.get('/:id/download', async (req, res) => {
  try {
    const doc = await db.documents.getById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const safeFilename = `${sanitizeFilename(doc.title)}.pdf`;
    const encodedFilename = encodeURIComponent(safeFilename);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);

    // If public URL available, fetch and pipe stream to client
    const targetUrl = doc.file_url || doc.file_path;
    if (targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      const response = await fetch(targetUrl);
      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to retrieve file from Supabase storage' });
      }
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }

    // Direct Supabase Storage download if relative key
    if (db.isSupabase && supabase) {
      const { data, error } = await supabase.storage.from(supabaseBucket).download(doc.file_path);
      if (error) {
        return res.status(502).json({ error: 'Failed to retrieve file from Supabase storage bucket' });
      }
      const buffer = Buffer.from(await data.arrayBuffer());
      return res.send(buffer);
    }

    // Local file fallback for offline testing only
    const fullPath = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', doc.file_path);
    if (fs.existsSync(fullPath)) {
      return fs.createReadStream(fullPath).pipe(res);
    }

    return res.status(404).json({ error: 'File could not be located' });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// GET /api/documents/:id/view - Inline view / preview PDF in browser from Supabase
router.get('/:id/view', async (req, res) => {
  try {
    const doc = await db.documents.getById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const targetUrl = doc.file_url || doc.file_path;
    if (targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      return res.redirect(targetUrl);
    }

    if (db.isSupabase && supabase) {
      const { data } = supabase.storage.from(supabaseBucket).getPublicUrl(doc.file_path);
      if (data && data.publicUrl) {
        return res.redirect(data.publicUrl);
      }
    }

    // Local file fallback for offline testing only
    const fullPath = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', doc.file_path);
    if (fs.existsSync(fullPath)) {
      const safeFilename = `${sanitizeFilename(doc.title)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
      return fs.createReadStream(fullPath).pipe(res);
    }

    return res.status(404).json({ error: 'File could not be located' });
  } catch (err) {
    console.error('View error:', err);
    res.status(500).json({ error: 'Failed to view document' });
  }
});

// POST /api/documents - Admin Upload document to Supabase (memory storage -> Supabase Storage 'pdfs' + documents table)
router.post('/', authMiddleware, (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds maximum limit of 10 MB' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'A PDF file is required' });
    }

    const { title, description, subsection_id, section_id, section, subsection } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Document title is required' });
    }

    if (!subsection_id && !subsection) {
      return res.status(400).json({ error: 'Subsection is required' });
    }

    try {
      let sectionName = section || '';
      let subsectionName = subsection || '';
      let targetSubId = subsection_id;
      let targetSecId = section_id;

      if (subsection_id) {
        const sub = await db.subsections.getById(subsection_id);
        if (sub) {
          subsectionName = sub.name;
          sectionName = sub.section_name || sectionName;
          targetSecId = sub.section_id || targetSecId;
        }
      }

      // Check magic bytes (%PDF) from memory buffer
      if (!verifyPdfMagicBytes(req.file.buffer)) {
        return res.status(400).json({ error: 'Corrupt or invalid PDF file format' });
      }

      // Upload PDF buffer to Supabase Storage bucket 'pdfs'
      const uploadResult = await storageService.uploadPdf(req.file.buffer, req.file.originalname);

      // Store title, description, section, subsection, file_url and file_path in Supabase documents table
      const created = await db.documents.create({
        title: title.trim(),
        description: (description || '').trim(),
        section: sectionName,
        subsection: subsectionName,
        section_id: targetSecId,
        subsection_id: targetSubId,
        file_url: uploadResult.fileUrl,
        file_path: uploadResult.filePath,
        file_size: uploadResult.fileSize
      });

      return res.status(201).json(created);
    } catch (insertErr) {
      console.error('Error saving document to Supabase:', insertErr);
      return res.status(500).json({ error: insertErr.message || 'Database error while saving document' });
    }
  });
});

// PUT /api/documents/:id - Admin Edit document (can also replace file optionally)
router.put('/:id', authMiddleware, (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds maximum limit of 10 MB' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    const docId = req.params.id;

    try {
      const existing = await db.documents.getById(docId);
      if (!existing) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const { title, description, subsection_id, section_id, section, subsection } = req.body;

      const newTitle = title ? title.trim() : existing.title;
      const newDesc = description !== undefined ? description.trim() : existing.description;
      const newSubId = subsection_id ? parseInt(subsection_id, 10) : existing.subsection_id;
      const newSecId = section_id ? parseInt(section_id, 10) : existing.section_id;

      if (!newTitle) {
        return res.status(400).json({ error: 'Document title cannot be empty' });
      }

      let sectionName = section || existing.section;
      let subsectionName = subsection || existing.subsection;

      if (newSubId) {
        const sub = await db.subsections.getById(newSubId);
        if (sub) {
          subsectionName = sub.name;
          sectionName = sub.section_name || sectionName;
        }
      }

      let fileUrl = existing.file_url;
      let filePath = existing.file_path;
      let fileSize = existing.file_size;

      if (req.file) {
        if (!verifyPdfMagicBytes(req.file.buffer)) {
          return res.status(400).json({ error: 'Corrupt or invalid PDF file format' });
        }

        // Upload new file to Supabase Storage bucket 'pdfs'
        const uploadResult = await storageService.uploadPdf(req.file.buffer, req.file.originalname);

        // Delete old file from storage
        await storageService.deletePdf(existing.file_path || existing.file_url);

        fileUrl = uploadResult.fileUrl;
        filePath = uploadResult.filePath;
        fileSize = uploadResult.fileSize;
      }

      const updated = await db.documents.update(docId, {
        title: newTitle,
        description: newDesc,
        section: sectionName,
        subsection: subsectionName,
        section_id: newSecId,
        subsection_id: newSubId,
        file_url: fileUrl,
        file_path: filePath,
        file_size: fileSize
      });

      return res.json(updated);
    } catch (updateErr) {
      console.error('Error updating document in Supabase:', updateErr);
      return res.status(500).json({ error: updateErr.message || 'Database error while updating document' });
    }
  });
});

// DELETE /api/documents/:id - Admin Delete document from Supabase
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const docId = req.params.id;
    const doc = await db.documents.getById(docId);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Remove file from Supabase Storage bucket 'pdfs'
    await storageService.deletePdf(doc.file_path || doc.file_url);

    // Delete document record from Supabase table 'documents'
    await db.documents.delete(docId);
    res.json({ message: `Document "${doc.title}" deleted successfully` });
  } catch (err) {
    console.error('Error deleting document from Supabase:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

module.exports = router;
