const bcrypt = require('bcryptjs');
const db = require('./db');

async function runSeed() {
  try {
    // 1. Seed Default Admin if table is empty or admin doesn't exist
    const adminCount = await db.admins.count();
    if (adminCount === 0) {
      console.log('No admin found. Seeding default admin user...');
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync('m2007', salt);
      await db.admins.create({ username: 'madhuri', password_hash: hash });
      console.log('Admin user created successfully (username: madhuri).');
    }

    // 2. Seed Default Sections and Subsections ONLY if sections table is empty
    const sectionCount = await db.sections.count();
    if (sectionCount === 0) {
      console.log('Sections table is empty. Seeding default sections and subsections...');
      const seedData = [
        // Main Sections
        { panel: 'main', section: 'PRC', subsections: ['2015 PRC', '2022 PRC'] },
        { panel: 'main', section: 'Service', subsections: ['Service'] },
        { panel: 'main', section: 'Leave', subsections: ['Earned Leave', 'ML/HPL', 'EOL'] },
        { panel: 'main', section: 'UGC', subsections: ['UGC RPS-2006', 'UGC RPS-2016', 'CAS'] },
        { panel: 'main', section: 'DA', subsections: ['DA GOs'] },
        { panel: 'main', section: 'RTF', subsections: ['RTF'] },
        { panel: 'main', section: 'Fees', subsections: ['Special fee', 'Restructured fee'] },

        // Bills Sections
        { panel: 'bills', section: 'Contingent Bills', subsections: ['Office Contingency', 'Lab & Library Equipment'] },
        { panel: 'bills', section: 'Salary Bills', subsections: ['Regular Pay Bills', 'Supplementary Pay Bills'] },
        { panel: 'bills', section: 'TA Bills', subsections: ['Tour TA Bills', 'Transfer TA Bills'] },
        { panel: 'bills', section: 'Medical Reimbursement', subsections: ['Medical Reimbursement'] },
        { panel: 'bills', section: 'Scholarship Bills', subsections: ['RTF & MTF Sanctions'] }
      ];

      for (const item of seedData) {
        let sec = await db.sections.findByNameAndPanel(item.section, item.panel);
        if (!sec) {
          sec = await db.sections.create({ name: item.section, panel: item.panel });
        }
        for (const subName of item.subsections) {
          const sub = await db.subsections.findBySectionAndName(sec.id, subName);
          if (!sub) {
            await db.subsections.create({ section_id: sec.id, name: subName });
          }
        }
      }
      console.log('Default sections and subsections seeded successfully.');
    }

    // Note: The dummy 684-byte placeholder PDF generation has been removed.
    // Real PDF uploads with full content and actual file sizes are uploaded by Admin.
  } catch (err) {
    console.error('Error in database seed/check:', err);
  }
}

if (require.main === module) {
  runSeed().then(() => {
    console.log('Seed check complete.');
  });
}

module.exports = runSeed;
