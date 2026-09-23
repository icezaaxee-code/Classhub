require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const getTodayThai = () => {
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
};

async function runAutoBackup() {
  try {
    console.log('🔄 กำลังเริ่มสำรองข้อมูลอัตโนมัติ...');
    
    // ดึงข้อมูลจากทุกตารางพร้อมกัน
    const [
      { data: settings },
      { data: users },
      { data: classrooms },
      { data: students },
      { data: attendance },
      { data: behaviors },
      { data: homeVisits },
      { data: studentCases },
      { data: assignments },
      { data: documents }
    ] = await Promise.all([
      supabase.from('Settings').select('*'),
      supabase.from('Users').select('*'),
      supabase.from('Classrooms').select('*'),
      supabase.from('Students').select('*'),
      supabase.from('Attendance').select('*'),
      supabase.from('Behaviors').select('*'),
      supabase.from('HomeVisits').select('*'),
      supabase.from('StudentCases').select('*'),
      supabase.from('Assignments').select('*'),
      supabase.from('Documents').select('*')
    ]);

    const backupData = {
      version: '1.0.0',
      app: 'CLASSHUB',
      backup_at: new Date().toISOString(),
      data: {
        Settings: settings || [],
        Users: users || [],
        Classrooms: classrooms || [],
        Students: students || [],
        Attendance: attendance || [],
        Behaviors: behaviors || [],
        HomeVisits: homeVisits || [],
        StudentCases: studentCases || [],
        Assignments: assignments || [],
        Documents: documents || []
      }
    };

    const fileName = `classhub_backup_${getTodayThai().replace(/-/g, '')}.json`;
    const jsonString = JSON.stringify(backupData, null, 2);

    // บันทึกไฟล์ลงในโฟลเดอร์ backup ของโปรเจกต์ฝั่งเซิร์ฟเวอร์
    const backupDir = path.join(__dirname, 'backup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const filePath = path.join(backupDir, fileName);
    fs.writeFileSync(filePath, jsonString, 'utf8');

    console.log(`✅ สำรองข้อมูลสำเร็จ! บันทึกไว้ที่: ${filePath}`);
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในการสำรองข้อมูล:', err.message);
  }
}

runAutoBackup();