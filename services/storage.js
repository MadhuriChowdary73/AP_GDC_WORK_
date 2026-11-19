/**
 * Unified Storage Service
 * Handles uploading, deleting, and resolving PDFs across Supabase Storage and local disk fallback.
 */
const path = require('path');
const fs = require('fs');
const { supabase, isConfigured, supabaseBucket } = require('../supabase');

const localUploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(localUploadsDir)) {
  fs.mkdirSync(localUploadsDir, { recursive: true });
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'document';
}

const StorageService = {
  /**
   * Upload a PDF buffer to storage
   * @param {Buffer} buffer - File buffer from multer memoryStorage
   * @param {string} originalName - Original filename
   * @returns {Promise<{ filePath: string, fileSize: number, isRemote: boolean }>}
   */
  async uploadPdf(buffer, originalName = 'document.pdf') {
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const cleanName = sanitizeFilename(path.parse(originalName).name);
    const filename = `doc_${timestamp}_${randomSuffix}_${cleanName}.pdf`;

    if (isConfigured && supabase) {
      // Upload to Supabase Storage Bucket
      const { data, error } = await supabase.storage
        .from(supabaseBucket)
        .upload(filename, buffer, {
          contentType: 'application/pdf',
          upsert: false
        });

      if (error) {
        throw new Error(`Supabase Storage upload failed: ${error.message}`);
      }

      // Retrieve public URL
      const { data: urlData } = supabase.storage
        .from(supabaseBucket)
        .getPublicUrl(filename);

      return {
        filePath: urlData.publicUrl,
        fileSize: buffer.length,
        storageKey: filename,
        isRemote: true
      };
    }

    // Local Disk Fallback
    const localPath = path.join(localUploadsDir, filename);
    fs.writeFileSync(localPath, buffer);
    const relativePath = path.join('uploads', filename);

    return {
      filePath: relativePath,
      fileSize: buffer.length,
      storageKey: filename,
      isRemote: false
    };
  },

  /**
   * Delete a PDF from storage
   * @param {string} filePathOrUrl
   */
  async deletePdf(filePathOrUrl) {
    if (!filePathOrUrl) return;

    if (filePathOrUrl.startsWith('http://') || filePathOrUrl.startsWith('https://')) {
      if (isConfigured && supabase) {
        try {
          const urlParts = filePathOrUrl.split('/');
          const filename = urlParts[urlParts.length - 1].split('?')[0];
          await supabase.storage.from(supabaseBucket).remove([filename]);
        } catch (err) {
          console.warn('Could not remove file from Supabase Storage:', err.message);
        }
      }
      return;
    }

    // Local disk deletion
    try {
      const fullPath = path.isAbsolute(filePathOrUrl) 
        ? filePathOrUrl 
        : path.join(__dirname, '..', filePathOrUrl);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (err) {
      console.warn('Could not remove file from local disk:', err.message);
    }
  }
};

module.exports = StorageService;
