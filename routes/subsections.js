const express = require('express');
const router = express.Router();
const db = require('../db');
const storageService = require('../services/storage');
const { authMiddleware } = require('../middleware/auth');

// GET /api/subsections - List all subsections (optional filter ?section_id=)
router.get('/', async (req, res) => {
  try {
    const { section_id } = req.query;
    const subsections = await db.subsections.getAll(section_id || null);
    res.json(subsections);
  } catch (err) {
    console.error('Error fetching subsections:', err);
    res.status(500).json({ error: 'Failed to retrieve subsections' });
  }
});

// GET /api/subsections/:id - Get single subsection
router.get('/:id', async (req, res) => {
  try {
    const subsection = await db.subsections.getById(req.params.id);
    if (!subsection) {
      return res.status(404).json({ error: 'Subsection not found' });
    }
    res.json(subsection);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve subsection' });
  }
});

// POST /api/subsections - Create subsection (Admin only)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { section_id, name } = req.body;
    if (!section_id) {
      return res.status(400).json({ error: 'Section ID is required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Subsection name is required' });
    }

    const trimmed = name.trim();
    const section = await db.sections.getById(section_id);
    if (!section) {
      return res.status(400).json({ error: 'Specified section does not exist' });
    }

    const existing = await db.subsections.findBySectionAndName(section_id, trimmed);
    if (existing) {
      return res.status(409).json({ error: 'A subsection with this name already exists in this section' });
    }

    const newSub = await db.subsections.create({ section_id, name: trimmed });
    res.status(201).json(newSub);
  } catch (err) {
    console.error('Error creating subsection:', err);
    res.status(500).json({ error: 'Failed to create subsection' });
  }
});

// PUT /api/subsections/:id - Rename/edit subsection (Admin only)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, section_id } = req.body;
    const subId = req.params.id;

    const sub = await db.subsections.getById(subId);
    if (!sub) {
      return res.status(404).json({ error: 'Subsection not found' });
    }

    const targetSectionId = section_id ? parseInt(section_id, 10) : sub.section_id;
    const targetName = name ? name.trim() : sub.name;

    if (!targetName) {
      return res.status(400).json({ error: 'Subsection name cannot be empty' });
    }

    // Verify target section exists
    const sec = await db.sections.getById(targetSectionId);
    if (!sec) {
      return res.status(400).json({ error: 'Target section does not exist' });
    }

    // Check duplicate
    const duplicate = await db.subsections.findBySectionAndName(targetSectionId, targetName, subId);
    if (duplicate) {
      return res.status(409).json({ error: 'Another subsection with this name already exists in this section' });
    }

    const updated = await db.subsections.update(subId, { name: targetName, section_id: targetSectionId });
    res.json(updated);
  } catch (err) {
    console.error('Error updating subsection:', err);
    res.status(500).json({ error: 'Failed to update subsection' });
  }
});

// DELETE /api/subsections/:id - Delete subsection (Admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const subId = req.params.id;
    const sub = await db.subsections.getById(subId);
    if (!sub) {
      return res.status(404).json({ error: 'Subsection not found' });
    }

    // Delete associated physical files
    const docs = await db.documents.getAll({ subsection_id: subId });
    for (const doc of docs) {
      try {
        await storageService.deletePdf(doc.file_path);
      } catch (fileErr) {
        console.warn('Could not remove file during subsection deletion:', doc.file_path);
      }
    }

    await db.subsections.delete(subId);
    res.json({ message: `Subsection "${sub.name}" and its documents were deleted successfully` });
  } catch (err) {
    console.error('Error deleting subsection:', err);
    res.status(500).json({ error: 'Failed to delete subsection' });
  }
});

module.exports = router;
