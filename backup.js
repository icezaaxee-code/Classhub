const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function backupAllTables() {
  const tables = ['Students', 'Classrooms', 'Attendance', 'Behaviors', 'HomeVisits', 'StudentCases'];
  
  for (const tableName of tables) {
    const { data, error } = await supabase.from(tableName).select('*');
    if (!error) {
      fs.writeFileSync(`${tableName}_backup.json`, JSON.stringify(data, null, 2));
      console.log(`✅ Backup ${tableName} successful!`);
    } else {
      console.error(`❌ Error backing up ${tableName}:`, error.message);
    }
  }
}

backupAllTables();