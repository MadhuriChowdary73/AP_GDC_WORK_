/**
 * Supabase Storage Service
 * Uploads and deletes PDFs from the Supabase Storage bucket ('pdfs').
 * Nothing is written to the local filesystem when Supabase is configured.
 */
const path = require('path');
const fs = require('fs');
const { supabase, isConfigured, supabaseBucket } = require('../supabase');

function sanitizeStorageFilename(filename) {
  // Replace every character other than letters, numbers, dot, dash and underscore with an underscore
  return filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

const StorageService = {
  /**
   * Upload a PDF buffer to Supabase Storage bucket ('pdfs')
   * @param {Buffer} buffer - File buffer from multer memoryStorage
   * @param {string} originalName - Original filename
   * @returns {Promise<{ fileUrl: string, filePath: string, fileSize: number, originalName: string, isRemote: boolean }>}
   */
  async uploadPdf(buffer, originalName = 'document.pdf') {
    const timestamp = Date.now();
    // Sanitize the file name: replace every character other than letters, numbers, dot, dash and underscore with an underscore
    const sanitizedName = sanitizeStorageFilename(originalName);
    // Prefix a timestamp and use the sanitized name only for the storage path
    const storagePath = `${timestamp}_${sanitizedName}`;

    if (isConfigured && supabase) {
      // Upload directly to Supabase Storage bucket 'pdfs'
      const { data, error } = await supabase.storage
        .from(supabaseBucket)
        .upload(storagePath, buffer, {
          contentType: 'application/pdf',
          upsert: false
        });

            if (error) {
                throw new Error(`Supabase Storage upload failed: ${error.message}`);
            }

      // Retrieve public URL
      const { data: urlData } = supabase.storage
        .from(supabaseBucket)
        .getPublicUrl(storagePath);

      return {
        fileUrl: urlData.publicUrl,
        filePath: storagePath,
        fileSize: buffer.length,
        originalName: originalName,
        isRemote: true
      };
    }

    // Offline test fallback only (when SUPABASE_URL & SUPABASE_KEY are omitted)
    const localUploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(localUploadsDir)) {
      fs.mkdirSync(localUploadsDir, { recursive: true });
    }
    const localPath = path.join(localUploadsDir, storagePath);
    fs.writeFileSync(localPath, buffer);
    const relativePath = path.join('uploads', storagePath);

    return {
      fileUrl: relativePath,
      filePath: relativePath,
      fileSize: buffer.length,
      originalName: originalName,
      isRemote: false
    };
  },

    /**
     * Delete a PDF from Supabase Storage bucket ('pdfs')
     * @param {string} filePathOrUrl
     */
    async deletePdf(filePathOrUrl) {
        if (!filePathOrUrl) return;

        if (isConfigured && supabase) {
            try {
                let filename = filePathOrUrl;
                if (filePathOrUrl.startsWith('http://') || filePathOrUrl.startsWith('https://')) {
                    const urlParts = filePathOrUrl.split('/');
                    filename = urlParts[urlParts.length - 1].split('?')[0];
                }
                await supabase.storage.from(supabaseBucket).remove([filename]);
            } catch (err) {
                console.warn('Could not remove file from Supabase Storage:', err.message);
            }
            return;
        }

        // Local disk deletion fallback for offline tests
        try {
            const fullPath = path.isAbsolute(filePathOrUrl)
                ? filePathOrUrl
                : path.join(__dirname, '..', filePathOrUrl);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        } catch (err) {
            console.warn('Could not remove local fallback file:', err.message);
        }
    }
};

module.exports = StorageService;
