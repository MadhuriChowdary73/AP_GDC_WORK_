const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const storageService = require('../services/storage');
const { authMiddleware } = require('../middleware/auth');

// Multer in-memory storage (processes buffer before uploading to Supabase or disk)
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

// Helper to verify PDF magic bytes (%PDF) from buffer or file
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

// GET /api/documents - Public listing with filters (section, subsection, search)
router.get('/', async (req, res) => {
  try {
    const { section_id, subsection_id, search } = req.query;
    const documents = await db.documents.getAll({ section_id, subsection_id, search });
    res.json(documents);
  } catch (err) {
    console.error('Error fetching documents:', err);
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

// GET /api/documents/:id/download - Download PDF with admin-given title
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

    // If remote URL (Supabase Storage)
    if (doc.file_path.startsWith('http://') || doc.file_path.startsWith('https://')) {
      const response = await fetch(doc.file_path);
      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to retrieve file from remote storage' });
      }
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }

    // Local file fallback
    const fullPath = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', doc.file_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File on disk could not be located' });
    }

    const fileStream = fs.createReadStream(fullPath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// GET /api/documents/:id/view - Inline view / preview PDF in browser
router.get('/:id/view', async (req, res) => {
  try {
    const doc = await db.documents.getById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // If remote URL (Supabase Storage), redirect to public URL for fast in-browser preview
    if (doc.file_path.startsWith('http://') || doc.file_path.startsWith('https://')) {
      return res.redirect(doc.file_path);
    }

    // Local file fallback
    const fullPath = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', doc.file_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File on disk could not be located' });
    }

    const safeFilename = `${sanitizeFilename(doc.title)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);

    const fileStream = fs.createReadStream(fullPath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('View error:', err);
    res.status(500).json({ error: 'Failed to view document' });
  }
});

// POST /api/documents - Admin Upload document
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

    const { title, description, subsection_id } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Document title is required' });
    }

    if (!subsection_id) {
      return res.status(400).json({ error: 'Subsection is required' });
    }

    try {
      // Verify subsection exists
      const sub = await db.subsections.getById(subsection_id);
      if (!sub) {
        return res.status(400).json({ error: 'Selected subsection does not exist' });
      }

      // Check magic bytes
      if (!verifyPdfMagicBytes(req.file.buffer)) {
        return res.status(400).json({ error: 'Corrupt or invalid PDF file format' });
      }

      // Upload file to storage (Supabase Storage or local disk fallback)
      const uploadResult = await storageService.uploadPdf(req.file.buffer, req.file.originalname);

      // Save metadata and file path/URL to database
      const created = await db.documents.create({
        title: title.trim(),
        description: (description || '').trim(),
        subsection_id,
        file_path: uploadResult.filePath,
        file_size: uploadResult.fileSize
      });

      return res.status(201).json(created);
    } catch (insertErr) {
      console.error('Error saving document:', insertErr);
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

      const { title, description, subsection_id } = req.body;

      const newTitle = title ? title.trim() : existing.title;
      const newDesc = description !== undefined ? description.trim() : existing.description;
      const newSubId = subsection_id ? parseInt(subsection_id, 10) : existing.subsection_id;

      if (!newTitle) {
        return res.status(400).json({ error: 'Document title cannot be empty' });
      }

      const sub = await db.subsections.getById(newSubId);
      if (!sub) {
        return res.status(400).json({ error: 'Selected subsection does not exist' });
      }

      let filePath = existing.file_path;
      let fileSize = existing.file_size;

      if (req.file) {
        if (!verifyPdfMagicBytes(req.file.buffer)) {
          return res.status(400).json({ error: 'Corrupt or invalid PDF file format' });
        }

        // Upload new file to storage
        const uploadResult = await storageService.uploadPdf(req.file.buffer, req.file.originalname);

        // Delete old file from storage
        await storageService.deletePdf(existing.file_path);

        filePath = uploadResult.filePath;
        fileSize = uploadResult.fileSize;
      }

      const updated = await db.documents.update(docId, {
        title: newTitle,
        description: newDesc,
        subsection_id: newSubId,
        file_path: filePath,
        file_size: fileSize
      });

      return res.json(updated);
    } catch (updateErr) {
      console.error('Error updating document:', updateErr);
      return res.status(500).json({ error: updateErr.message || 'Database error while updating document' });
    }
  });
});

// DELETE /api/documents/:id - Admin Delete document
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const docId = req.params.id;
    const doc = await db.documents.getById(docId);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Remove file from storage
    await storageService.deletePdf(doc.file_path);

    // Delete document record
    await db.documents.delete(docId);
    res.json({ message: `Document "${doc.title}" deleted successfully` });
  } catch (err) {
    console.error('Error deleting document:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

module.exports = router;
