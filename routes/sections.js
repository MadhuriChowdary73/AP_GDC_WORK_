const express = require('express');
const router = express.Router();
const db = require('../db');
const storageService = require('../services/storage');
const { authMiddleware } = require('../middleware/auth');

// GET /api/sections - List sections (optional filter ?panel=main or ?panel=bills)
router.get('/', async (req, res) => {
  try {
    const { panel } = req.query;
    const sections = await db.sections.getAll(panel);
    res.json(sections);
  } catch (err) {
    console.error('Error fetching sections:', err);
    res.status(500).json({ error: 'Failed to retrieve sections' });
  }
});

// GET /api/sections/:id - Get single section
router.get('/:id', async (req, res) => {
  try {
    const section = await db.sections.getById(req.params.id);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }
    res.json(section);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve section' });
  }
});

// GET /api/sections/:id/subsections - List subsections for a section
router.get('/:id/subsections', async (req, res) => {
  try {
    const sectionId = req.params.id;
    const section = await db.sections.getById(sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const subsections = await db.sections.getSubsections(sectionId);
    res.json(subsections);
  } catch (err) {
    console.error('Error fetching subsections for section:', err);
    res.status(500).json({ error: 'Failed to retrieve subsections' });
  }
});

// POST /api/sections - Create section (Admin only)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, panel } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Section name is required' });
    }

    const targetPanel = panel && (panel === 'bills' || panel === 'main') ? panel : 'main';
    const trimmed = name.trim();

    // Check duplicate within the same panel
    const existing = await db.sections.findByNameAndPanel(trimmed, targetPanel);
    if (existing) {
      return res.status(409).json({ error: `A section with this name already exists in the ${targetPanel} panel` });
    }

    const newSection = await db.sections.create({ name: trimmed, panel: targetPanel });
    res.status(201).json(newSection);
  } catch (err) {
    console.error('Error creating section:', err);
    res.status(500).json({ error: 'Failed to create section' });
  }
});

// POST /api/sections/:id/subsections - Add subsection under section :id (Admin only)
router.post('/:id/subsections', authMiddleware, async (req, res) => {
  try {
    const sectionId = req.params.id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Subsection name is required' });
    }

    const section = await db.sections.getById(sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Parent section not found' });
    }

    const trimmed = name.trim();
    const existing = await db.subsections.findBySectionAndName(sectionId, trimmed);
    if (existing) {
      return res.status(409).json({ error: 'A subsection with this name already exists in this section' });
    }

    const newSub = await db.subsections.create({ section_id: sectionId, name: trimmed });
    res.status(201).json(newSub);
  } catch (err) {
    console.error('Error creating subsection under section:', err);
    res.status(500).json({ error: 'Failed to create subsection' });
  }
});

// PUT /api/sections/:id - Rename section (Admin only)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, panel } = req.body;
    const sectionId = req.params.id;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Section name is required' });
    }

    const trimmed = name.trim();
    const section = await db.sections.getById(sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const targetPanel = panel && (panel === 'bills' || panel === 'main') ? panel : section.panel;

    const duplicate = await db.sections.findByNameAndPanel(trimmed, targetPanel, sectionId);
    if (duplicate) {
      return res.status(409).json({ error: `Another section with this name already exists in the ${targetPanel} panel` });
    }

    const updated = await db.sections.update(sectionId, { name: trimmed, panel: targetPanel });
    res.json(updated);
  } catch (err) {
    console.error('Error updating section:', err);
    res.status(500).json({ error: 'Failed to update section' });
  }
});

// DELETE /api/sections/:id - Delete section (Admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const sectionId = req.params.id;
    const section = await db.sections.getById(sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    // Find all files belonging to documents in this section to delete
    const docs = await db.documents.getAll({ section_id: sectionId });
    for (const doc of docs) {
      try {
        await storageService.deletePdf(doc.file_path);
      } catch (fileErr) {
        console.warn('Could not remove file during section deletion:', doc.file_path);
      }
    }

    await db.sections.delete(sectionId);
    res.json({ message: `Section "${section.name}" and all its contents were deleted successfully` });
  } catch (err) {
    console.error('Error deleting section:', err);
    res.status(500).json({ error: 'Failed to delete section' });
  }
});

module.exports = router;
