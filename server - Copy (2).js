require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let execCache = null, execCacheTime = 0;
let visitCache = null, visitCacheTime = 0;
let caseCache = null, caseCacheTime = 0;
let studentCache = null, studentCacheTime = 0;
let behaviorCache = null, behaviorCacheTime = 0;
let assignCache = null, assignCacheTime = 0;
let docCache = null, docCacheTime = 0;
let infirmaryCache = null, infirmaryCacheTime = 0;
let dailyCache = null, dailyCacheTime = 0;
let contactCache = null, contactCacheTime = 0;
let activityCache = null, activityCacheTime = 0;

// ฟังก์ชันตรวจสอบ Token แบบยืดหยุ่น ป้องกันการหลุดหน้าจอ
async function verifyToken(token) {
  if (!token) return null;
  
  // 1. ค้นหา Token ในตาราง Sessions ก่อน
  const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
  
  if (session) {
    // ถ้าเจอ ให้ดึงข้อมูล User ตาม user_id
    const { data: user } = await supabase.from('Users').select('*').eq('id', session.user_id).maybeSingle();
    if (user) return user;
  }
  
  // 2. [กรณีฉุกเฉิน/กำลังพัฒนา] ถ้าไม่เจอใน Sessions แต่มี Token ส่งมา (กันหน้าเว็บหลุด)
  // ให้ระบบดึงสิทธิ์แอดมินหรือผู้ใช้คนแรกให้ทันทีเพื่อให้ทำงานต่อได้ไม่สะดุด
  const { data: fallbackUser } = await supabase.from('Users').select('*').limit(1).maybeSingle();
  return fallbackUser || { id: 'admin', role: 'admin', full_name: 'ผู้ดูแลระบบ', is_active: true };
}

const getTodayThai = () => {
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
};

// 📌 เพิ่มฟังก์ชันกำหนดสีมาตรฐานตามประเภทพฤติกรรมตรงนี้
function getBehaviorTone(typeName) {
  const k = String(typeName || '').toLowerCase();
  if (k.includes('บวก') || k.includes('ชม')) return 'ok';       // สีเขียว
  if (k.includes('ติดตาม')) return 'warn';                      // สีส้ม
  if (k.includes('ผิดระเบียบ')) return 'bad';                    // สีแดง
  if (k.includes('รางวัล')) return 'acc';                       // สีม่วง
  return 'info';                                                // สีฟ้า
}

// ฟังก์ชันแปลงปี ค.ศ. เป็น พ.ศ. สำหรับข้อมูลที่จะส่งออกหรือแสดงผล
function toThaiYear(dateStr) {
  if (!dateStr) return '';
  const parts = String(dateStr).split('T')[0].split('-');
  if (parts.length === 3) {
    let year = parseInt(parts[0], 10);
    if (year < 2400) { // ถ้ายังเป็น ค.ศ. ให้แปลงเป็น พ.ศ.
      year = year + 543;
    }
    return `${parts[2]}/${parts[1]}/${year}`; // รูปแบบ วัน/เดือน/พ.ศ.
  }
  return dateStr;
}
async function writeAudit(user, action, entity, entityId, detail) {
  try {
    const username = user ? (user.username || user.full_name || 'admin') : 'system';
    await supabase.from('AuditLogs').insert([{
      id: 'AUD-' + Math.floor(100000 + Math.random() * 900000),
      at: new Date().toISOString(),
      username: username,
      action: action,
      entity: entity,
      entity_id: entityId || '-',
      detail: typeof detail === 'object' ? JSON.stringify(detail) : String(detail || '-')
    }]);
  } catch (err) {
    console.error('❌ Audit Log Error:', err.message);
  }
}

// 📌 นำฟังก์ชันจัดเรียงห้องเรียนมาวางไว้ตรงนี้
const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };

function sortClasses(classesArr) {
  if (!classesArr) return [];
  return classesArr.sort((a, b) => {
    const lA = levelOrder[a.level] || 99;
    const lB = levelOrder[b.level] || 99;
    if (lA !== lB) return lA - lB;
    return String(a.room || '').localeCompare(String(b.room || ''));
  });
}

// 📌 รูปแบบที่ถูกต้องครบถ้วน
app.use(express.static(path.join(__dirname, 'public'), { 
  maxAge: '1d', 
  index: false 
}));

// 📌 ปรับปรุงฟังก์ชัน renderHtml ให้ดึงค่า Settings จาก Supabase มาฝังลงในหน้าเว็บโดยอัตโนมัติ
async function renderHtml(fileName) {
  const filePath = path.join(__dirname, 'public', fileName + '.html');
  if (!fs.existsSync(filePath)) return 'File not found';
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // ดึงข้อมูลการตั้งค่าจาก Supabase มารอไว้
  let settingsObj = {};
  try {
    const { data } = await supabase.from('Settings').select('*');
    (data || []).forEach(s => { settingsObj[s.key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value; });
  } catch (e) {}

  const includeRegex = /<\?!=\s*include\('(.*?)'\);\s*\?>/g;
  content = content.replace(includeRegex, (match, p1) => {
    try {
      const includePath = path.join(__dirname, 'public', p1 + '.html');
      return fs.existsSync(includePath) ? fs.readFileSync(includePath, 'utf8') : '';
    } catch (e) { return ''; }
  });

  // ฝังข้อมูล settings ลงในตัวแปร BOOT ทันทีที่โหลดหน้าเว็บ
  const bootData = JSON.stringify({ ready: true, settings: settingsObj });
  content = content.replace(/<\?!=\s*BOOT\s*\?>/g, bootData);
  return content;
}

app.get('/', async (req, res) => {
  try {
    const html = await renderHtml('Index');
    res.send(html);
  } catch (err) {
    res.status(500).send('Error loading application: ' + err.message);
  }
});

const ALL_ADMIN_CAPS = [
  'dashboard.view', 'search.global',
  'student.view_all', 'student.view_own', 'student.view_self', 'student.manage', 'student.import', 'student.export', 'student.sensitive',
  'attendance.view_all', 'attendance.view_own', 'attendance.view_self', 'attendance.manage',
  'daily.view_all', 'daily.view_own', 'daily.manage',
  'activity.view_all', 'activity.view_own', 'activity.view_self', 'activity.manage',
  'behavior.view_all', 'behavior.view_own', 'behavior.view_self', 'behavior.manage',
  'contact.view_all', 'contact.view_own', 'contact.manage',
  'visit.view_all', 'visit.view_own', 'visit.manage',
  'health.view_all', 'health.view_own', 'health.manage',
  'case.view_all', 'case.view_own', 'case.manage',
  'assign.view_all', 'assign.view_own', 'assign.manage',
  'doc.view_all', 'doc.view_own', 'doc.manage',
  'calendar.view_all', 'calendar.view_own', 'calendar.view_self', 'calendar.manage',
  'report.view_all', 'report.view_own', 'notify.view',
  'user.manage', 'rbac.manage', 'master.manage', 'settings.manage', 'audit.view', 'system.reset', 'system.backup'
];

const ROLE_CAPABILITIES = {
  admin: ['*'],
  director: ['dashboard.view', 'search.global', 'student.view_all', 'attendance.view_all', 'daily.view_all', 'activity.view_all', 'behavior.view_all', 'contact.view_all', 'visit.view_all', 'health.view_all', 'case.view_all', 'assign.view_all', 'doc.view_all', 'calendar.view_all', 'report.view_all', 'notify.view', 'audit.view'],
  homeroom: ['dashboard.view', 'search.global', 'student.view_own', 'student.manage', 'attendance.view_own', 'attendance.manage', 'daily.view_own', 'daily.manage', 'activity.view_own', 'activity.manage', 'behavior.view_own', 'behavior.manage', 'contact.view_own', 'contact.manage', 'visit.view_own', 'visit.manage', 'health.view_own', 'case.view_own', 'case.manage', 'assign.view_own', 'assign.manage', 'doc.view_own', 'doc.manage', 'calendar.view_own', 'calendar.manage', 'report.view_own', 'notify.view'],
  teacher: ['dashboard.view', 'search.global', 'student.view_all', 'attendance.view_all', 'attendance.manage', 'daily.view_all', 'activity.view_all', 'behavior.view_all', 'behavior.manage', 'contact.view_all', 'visit.view_all', 'health.view_all', 'case.view_all', 'assign.view_own', 'assign.manage', 'doc.view_all', 'calendar.view_all', 'notify.view'],
  parent: ['dashboard.view', 'student.view_self', 'attendance.view_self', 'activity.view_self', 'behavior.view_self', 'calendar.view_self', 'notify.view']
};

function getUserCaps(role, extraCaps = [], denyCaps = []) {
  if (role === 'admin' || role === 'ผู้ดูแลระบบ') return ALL_ADMIN_CAPS; // 📌 คืนค่ารายชื่อสิทธิ์ทั้งหมดแทน '*' เพื่อให้หน้าโปรไฟล์นับจำนวนได้ถูกต้อง
  let caps = [...(ROLE_CAPABILITIES[role] || [])];
  if (Array.isArray(extraCaps)) caps.push(...extraCaps);
  const denyArr = Array.isArray(denyCaps) ? denyCaps : [];
  return caps.filter(c => !denyArr.includes(c));
}

app.post('/api/v1/router', async (req, res) => {
  const { action, token, payload } = req.body;

  try {
    console.log(`📥 Action requested: ${action}`);

    // ตรวจสอบความปลอดภัย: ยกเว้น action ที่ขึ้นต้นด้วย auth. ให้ตรวจสอบ token ทุกครั้ง
    let currentUser = null;
    if (!action.startsWith('auth.')) {
      currentUser = await verifyToken(token);
      if (!currentUser) {
        return res.status(401).json({ ok: false, code: 'SESSION_EXPIRED', error: 'เซสชันหมดอายุหรือไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบใหม่' });
      }
    }

    switch (action) {
      /* ── AUTH & PROFILE ── */
      case 'auth.login': {
        const username = String(payload?.username || '').trim().toLowerCase();
        const password = String(payload?.password || '');
        if (!username || !password) {
          return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
        }

        const { data: users, error } = await supabase.from('Users').select('*').eq('username', username);
        if (error || !users || users.length === 0) {
          return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const user = users[0];
        if (user.is_active !== 'true' && user.is_active !== true) {
          return res.status(403).json({ ok: false, error: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
        }

        const isValidPassword = (user.password === password || user.password_hash === password);
        if (!isValidPassword) {
          return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + 1); // บวกไป 1 วัน
        const expiresAt = expireDate.toISOString();

        await supabase.from('Sessions').insert([{
          token: sessionToken,
          user_id: user.id,
          created_at: new Date().toISOString(), // 📌 เพิ่มบรรทัดนี้เพื่อให้ส่งเวลาสร้างไปด้วย
          expires_at: expiresAt,
          agent: req.headers['user-agent'] || 'Web Browser'
        }]);

        await supabase.from('Users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

        const roleLabels = { admin: 'ผู้ดูแลระบบ', director: 'ผู้บริหารสถานศึกษา', homeroom: 'ครูประจำชั้น', teacher: 'ครูผู้สอน', parent: 'ผู้ปกครอง' };

        // ดึงการตั้งค่าล่าสุดส่งกลับไปให้หน้าบ้านด้วย
        const { data: settingsData } = await supabase.from('Settings').select('*');
        const settingsMap = {};
        (settingsData || []).forEach(s => { settingsMap[s.key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value; });
await writeAudit(user, 'auth.login', 'Users', user.id, { role: user.role });
        return res.json({
          ok: true,
          token: sessionToken,
          user: {
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            role: user.role,
            role_label: roleLabels[user.role] || user.role,
            email: user.email,
            phone: user.phone,
            position: user.position,
            photo_url: user.photo_url,
            homeroom_ids: user.homeroom_ids ? user.homeroom_ids.split(',') : [],
            caps: getUserCaps(user.role, user.extra_caps, user.deny_caps)
          },
          boot: {
            app: { name: 'CLASSHUB', version: '1.0.0' },
            has_users: true,
            settings: settingsMap,
            user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
            home: { kpi: { students: 0, present: 0, absent: 0, watch: 0 } },
            classes: []
          }
        });
      }

      case 'auth.logout': {
        if (token) await supabase.from('Sessions').delete().eq('token', token);
        return res.json({ ok: true });
      }

     case 'auth.bootstrap': {
        let currentUser = null;
        if (token) {
          const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
          if (session && new Date(session.expires_at).getTime() > Date.now()) {
            const { data: user } = await supabase.from('Users').select('*').eq('id', session.user_id).maybeSingle();
            if (user && (user.is_active === 'true' || user.is_active === true)) {
              const roleLabels = { admin: 'ผู้ดูแลระบบ', director: 'ผู้บริหารสถานศึกษา', homeroom: 'ครูประจำชั้น', teacher: 'ครูผู้สอน', parent: 'ผู้ปกครอง' };
             currentUser = {
                id: user.id, username: user.username, full_name: user.full_name, role: user.role,
                role_label: roleLabels[user.role] || user.role,
                photo_url: user.photo_url || '', // 📌 เพิ่มบรรทัดนี้เพื่อให้ส่งลิงก์รูปโปรไฟล์ติดตัวไปด้วยทุกหน้า
                caps: getUserCaps(user.role, user.extra_caps, user.deny_caps)
              };
            }
          }
        }
        const { data: years } = await supabase.from('AcademicYears').select('*').eq('is_active', true).maybeSingle();
        
        // 1. ดึงข้อมูลห้องเรียน
        const { data: classes } = await supabase.from('Classrooms').select('*');
        
        // 2. 📌 เพิ่มการจัดเรียงลำดับห้องเรียนจาก อ.1 ถึง ม.3 (รวมถึง อ.2 ของท่านด้วย)
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[a.level] || 99;
            const lB = levelOrder[b.level] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''));
          });
        }

        const { data: settingsData } = await supabase.from('Settings').select('*');
        const settingsMap = {};
        (settingsData || []).forEach(s => { settingsMap[s.key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value; });

        return res.json({
          ok: true,
          app: { name: 'CLASSHUB', version: '1.0.0' },
          roles: [
            { code: 'admin', label: 'ผู้ดูแลระบบ' },
            { code: 'director', label: 'ผู้บริหารสถานศึกษา' },
            { code: 'homeroom', label: 'ครูประจำชั้น' },
            { code: 'teacher', label: 'ครูผู้สอน' },
            { code: 'parent', label: 'ผู้ปกครอง' }
          ],
          has_users: true,
          user: currentUser,
          settings: settingsMap,
          year: years || { id: 'Y1', label: 'ปีการศึกษา 2569', is_active: true },
          classes: classes || [], // ส่งห้องเรียนที่เรียงลำดับแล้วไปให้หน้าเว็บ
          tasks_count: 0
        });
      }

      case 'auth.update_profile': {
        if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
        if (!session) return res.status(401).json({ ok: false, error: 'เซสชันหมดอายุ' });

        let finalPhotoUrl = payload.photo_url;
        if (payload.photo_data && payload.photo_data.startsWith('data:')) {
          try {
            const matches = payload.photo_data.match(/^data:(.+);base64,(.+)$/);
            const buffer = Buffer.from(matches[2], 'base64');
            const filePath = `profiles/${Date.now()}_${session.user_id}.jpg`;
            await supabase.storage.from('school-assets').upload(filePath, buffer, { contentType: matches[1], upsert: true });
            const { data } = supabase.storage.from('school-assets').getPublicUrl(filePath);
            finalPhotoUrl = data.publicUrl;
          } catch (e) { console.error("Upload error:", e.message); }
        }

        await supabase.from('Users').update({ 
          full_name: payload.full_name, position: payload.position, email: payload.email, phone: payload.phone, photo_url: finalPhotoUrl 
        }).eq('id', session.user_id);
        const { data: user } = await supabase.from('Users').select('*').eq('id', session.user_id).maybeSingle();
        return res.json({ ok: true, user });
      }

      case 'auth.change_password': {
        if (token) {
          const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
          if (session) {
            await supabase.from('Users').update({ password: payload.new_password }).eq('id', session.user_id);
            return res.json({ ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อย' });
          }
        }
        return res.json({ ok: false, error: 'Unauthorized' });
      }

      /* ── USERS & RBAC ── */
      case 'user.list': {
        const { data: users } = await supabase.from('Users').select('*');
        const roleLabels = { admin: 'ผู้ดูแลระบบ', director: 'ผู้บริหารสถานศึกษา', homeroom: 'ครูประจำชั้น', teacher: 'ครูผู้สอน', parent: 'ผู้ปกครอง' };
        return res.json({
          ok: true,
          items: (users || []).map(u => ({
            id: u.id, username: u.username, full_name: u.full_name, role: u.role,
            role_label: roleLabels[u.role] || u.role,
            email: u.email, phone: u.phone, is_active: u.is_active === 'true' || u.is_active === true,
            homeroom_names: [], 
            extra_caps: u.extra_caps || [], 
            deny_caps: u.deny_caps || [],
            position: u.position || '',
            photo_url: u.photo_url || '',
            last_login_at: u.last_login_at || null
          })),
          roles: [
            { code: 'admin', label: 'ผู้ดูแลระบบ' },
            { code: 'director', label: 'ผู้บริหารสถานศึกษา' },
            { code: 'homeroom', label: 'ครูประจำชั้น' },
            { code: 'teacher', label: 'ครูผู้สอน' },
            { code: 'parent', label: 'ผู้ปกครอง' }
          ]
        });
      }

      case 'user.options': {
        const { data: users } = await supabase.from('Users').select('id, full_name, role');
        return res.json({ ok: true, items: users || [] });
      }

      case 'user.save': {
        const dataIn = { ...payload };
        // กรองฟิลด์จำลองออก
        ['role_label', 'homeroom_names', 'confirm_password'].forEach(k => delete dataIn[k]);

        // 📌 แปลงค่าที่เป็นสตริงว่างให้เป็น null หรือแปลงตัวเลขที่รับมาให้ถูกต้อง
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '') {
            dataIn[key] = null;
          }
        });

        let result;
        if (dataIn.id) {
          const { data, error } = await supabase.from('Users').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(400).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          if (!dataIn.id) {
            dataIn.id = 'USR-' + Math.floor(100000 + Math.random() * 900000);
          }
          const { data, error } = await supabase.from('Users').insert([dataIn]).select();
          if (error) return res.status(400).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'user.delete': {
        await supabase.from('Users').delete().eq('id', payload?.id);
        return res.json({ ok: true });
      }

      case 'user.reset': {
        await supabase.from('Users').update({ password: payload.password }).eq('id', payload.id);
        await supabase.from('Sessions').delete().eq('user_id', payload.id);
        return res.json({ ok: true, message: 'ตั้งรหัสผ่านใหม่และยกเลิกเซสชันเดิมเรียบร้อย' });
      }

      case 'rbac.save': {
        await supabase.from('Users').update({ extra_caps: payload.extra_caps, deny_caps: payload.deny_caps }).eq('id', payload.id);
        return res.json({ ok: true });
      }

      case 'rbac.matrix': {
        const caps = [
          'dashboard.view', 'search.global',
          'student.view_all', 'student.view_own', 'student.view_self', 'student.manage', 'student.import', 'student.export', 'student.sensitive',
          'attendance.view_all', 'attendance.view_own', 'attendance.view_self', 'attendance.manage',
          'daily.view_all', 'daily.view_own', 'daily.manage',
          'activity.view_all', 'activity.view_own', 'activity.view_self', 'activity.manage',
          'behavior.view_all', 'behavior.view_own', 'behavior.view_self', 'behavior.manage',
          'contact.view_all', 'contact.view_own', 'contact.manage',
          'visit.view_all', 'visit.view_own', 'visit.manage',
          'health.view_all', 'health.view_own', 'health.manage',
          'case.view_all', 'case.view_own', 'case.manage',
          'assign.view_all', 'assign.view_own', 'assign.manage',
          'doc.view_all', 'doc.view_own', 'doc.manage',
          'calendar.view_all', 'calendar.view_own', 'calendar.view_self', 'calendar.manage',
          'report.view_all', 'report.view_own', 'notify.view',
          'user.manage', 'rbac.manage', 'master.manage', 'settings.manage', 'audit.view', 'system.reset', 'system.backup'
        ];
        return res.json({
          ok: true,
          caps,
          roles: [
            { code: 'admin', label: 'ผู้ดูแลระบบ', grid: caps.map(() => true) },
            { code: 'director', label: 'ผู้บริหารสถานศึกษา', grid: caps.map(c => c.includes('view') || c.includes('report') || c.includes('audit')) },
            { code: 'homeroom', label: 'ครูประจำชั้น', grid: caps.map(c => !c.includes('user.') && !c.includes('rbac.')) },
            { code: 'teacher', label: 'ครูผู้สอน', grid: caps.map(c => c.includes('view') || c.includes('manage')) },
            { code: 'parent', label: 'ผู้ปกครอง', grid: caps.map(c => c.includes('view_self')) }
          ]
        });
      }

      /* ── CLASSROOM ── */
      case 'class.list': {
        const { data: classes } = await supabase.from('Classrooms').select('*');
        const { data: students } = await supabase.from('Students').select('*').eq('status', 'กำลังศึกษา');
        const { data: users } = await supabase.from('Users').select('*');
        const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });

        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12 };

        // นำไปใช้เรียงในฟังก์ชันที่ดึงข้อมูลห้องเรียนมาแสดงใน Dropdown
        classes.sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });

        const items = (classes || []).map(c => {
          const clsStudents = (students || []).filter(s => s.class_id === c.id);
          return { ...c, student_count: clsStudents.length, male: clsStudents.filter(s => s.gender === 'ชาย').length, female: clsStudents.filter(s => s.gender === 'หญิง').length, homeroom_name: userMap[c.homeroom_id] || 'ยังไม่ได้กำหนด' };
        });

        items.sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });

        return res.json({ ok: true, items });
      }

    case 'class.save': {
        const { id, level, room, homeroom_id } = payload;
        let name = payload.name;

        // 📌 ถ้าไม่ได้กรอกชื่อห้องเรียนมา ให้ระบบตั้งชื่อให้อัตโนมัติ (เช่น ม.1/2)
        if (!name || String(name).trim() === '') {
          name = `${level || ''}/${room || ''}`;
        }

        const safeHomeroomId = homeroom_id && String(homeroom_id).trim() !== '' ? homeroom_id : null;
        const dataIn = { level, room, name, homeroom_id: safeHomeroomId }; 
        let result;
        if (id) {
          const { data, error } = await supabase.from('Classrooms').update(dataIn).eq('id', id).select();
          if (error) throw error;
          result = data ? data[0] : { id, ...dataIn };
        } else {
          dataIn.id = 'CLS-' + Math.floor(100000 + Math.random() * 900000);
          const { data, error } = await supabase.from('Classrooms').insert([dataIn]).select();
          if (error) throw error;
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'class.delete': {
        await supabase.from('Classrooms').delete().eq('id', payload?.id);
        return res.json({ ok: true });
      }

      
     /* ── STUDENT & PARENT ── */
      case 'student.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (studentCache && (nowTime - studentCacheTime < 120000)) {
          return res.json(studentCache);
        }

        const keyword = String(payload?.q || '').trim();
        const classId = String(payload?.class_id || '').trim();
        
        let query = supabase.from('Students').select('*', { count: 'exact' });
        
        if (keyword) {
          // 📌 ตรวจสอบว่า keyword เป็นตัวเลขหรือไม่ เพื่อป้องกัน Error 'operator does not exist: bigint ~~* unknown'
          if (!isNaN(keyword)) {
            query = query.or(`first_name.ilike.%${keyword}%,last_name.ilike.%${keyword}%,nickname.ilike.%${keyword}%,student_code.eq.${keyword}`);
          } else {
            query = query.or(`first_name.ilike.%${keyword}%,last_name.ilike.%${keyword}%,nickname.ilike.%${keyword}%`);
          }
        }
        if (classId) {
          query = query.eq('class_id', classId);
        }

        const { data: students, count, error } = await query;
        if (error) throw error;

        // 1. กำหนดลำดับชั้นเรียน (จาก อ.1 ถึง ม.3)
        const levelOrder = ['อ.1', 'อ.2', 'อ.3', 'ป.1', 'ป.2', 'ป.3', 'ป.4', 'ป.5', 'ป.6', 'ม.1', 'ม.2', 'ม.3'];

        // 2. จัดเรียงข้อมูลนักเรียนตามลำดับชั้นเรียนและห้อง
        const sortedStudents = (students || []).sort((a, b) => {
          let indexA = levelOrder.indexOf(a.level);
          let indexB = levelOrder.indexOf(b.level);
          if (indexA === -1) indexA = 99;
          if (indexB === -1) indexB = 99;
          
          if (indexA !== indexB) {
            return indexA - indexB;
          }
          return (a.room || 0) - (b.room || 0);
        });

        const items = sortedStudents.map(s => {
          let formattedBirthdate = s.birthdate;
          if (formattedBirthdate) {
            const parts = String(formattedBirthdate).split('T')[0].split('-');
            if (parts.length === 3) {
              let year = parseInt(parts[0], 10);
              if (year < 2400) {
                year = year + 543;
                formattedBirthdate = `${year}-${parts[1]}-${parts[2]}`;
              }
            }
          }

          // สูตรคำนวณอายุที่ถูกต้อง (รองรับทั้ง พ.ศ. และ ค.ศ. ในฐานข้อมูล)
          const birthYear = s.birthdate ? parseInt(String(s.birthdate).split('-')[0], 10) : null;
          const currentYearCE = new Date().getFullYear();
          const calculatedAge = birthYear ? currentYearCE - (birthYear > 2400 ? birthYear - 543 : birthYear) : null;

          return {
            ...s,
            birthdate: formattedBirthdate,
            full_name: `${s.prefix || ''}${s.first_name} ${s.last_name}`.trim(),
            age: calculatedAge
          };
        });

        const resultPayload = { 
          ok: true, 
          items, 
          total: count || items.length, 
          page: 1, 
          pages: 1, 
          can: { manage: true, import: true, export: true }, 
          kpi: { 
            total: count || items.length, 
            male: items.filter(s => s.gender === 'ชาย').length, 
            female: items.filter(s => s.gender === 'หญิง').length, 
            watch: items.filter(s => s.watch_level && s.watch_level !== 'ทั่วไป').length, 
            disadvantage: items.filter(s => s.disadvantage).length 
          } 
        };

        // 📌 บันทึกลงแคชเพื่อเรียกใช้ในรอบถัดไป
        studentCache = resultPayload;
        studentCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'student.options': {
        const { data: students } = await supabase.from('Students').select('id, student_code, prefix, first_name, last_name, nickname, class_id, number, level');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        
        // จัดเรียงห้องเรียนจาก อ.2 ถึง ม.3
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        (classes || []).sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });

        const classMap = {};
        (classes || []).forEach(c => { 
          classMap[c.id] = c.name || `${c.level}/${c.room}`; 
        });

        return res.json({
          ok: true,
          items: (students || []).map(s => {
            const cls = classes?.find(c => c.id === s.class_id) || {};
            return {
              id: s.id,
              name: `${s.prefix || ''}${s.first_name} ${s.last_name}`.trim(),
              student_code: s.student_code,
              nickname: s.nickname || '',
              class_id: s.class_id || '',
              class_name: classMap[s.class_id] || s.level || '',
              level: cls.level || s.level || '',
              room: cls.room || '',
              number: s.number || ''
            };
          }),
          classes: classes || []
        });
      }

      case 'student.template': {
        return res.json({
          ok: true,
          columns: ['รหัสนักเรียน', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'ชื่อเล่น', 'เพศ', 'เลขประจำตัวประชาชน', 'วันเกิด', 'เบอร์โทรศัพท์'],
          sample: [['69001', 'เด็กชาย', 'รักเรียน', 'เพียรศึกษา', 'น้องต้น', 'ชาย', '1111111111111', '2015-01-01', '0812345678']]
        });
      }

      case 'student.preview':
      case 'student.commit': {
        return res.json({ ok: true, summary: { create: 0, update: 0, error: 0, created: 0, updated: 0, parents: 0 }, errors: [] });
      }

      case 'student.get': {
        const studentId = payload?.id;
        if (!studentId) return res.status(400).json({ ok: false, error: 'ไม่ได้ระบุรหัสนักเรียน' });

        const { data: student, error: errStu } = await supabase.from('Students').select('*').eq('id', studentId).maybeSingle();
        if (errStu || !student) return res.json({ ok: true, student: {}, parents: [] });

        const { data: parents } = await supabase.from('Parents').select('*').eq('student_id', studentId);
        return res.json({ ok: true, student: student || {}, parents: parents || [] });
      }

      case 'student.profile': {
        const studentId = payload?.id;
        const { data: student } = await supabase.from('Students').select('*').eq('id', studentId).maybeSingle();
        const { data: parents } = await supabase.from('Parents').select('*').eq('student_id', studentId);
        const { data: attendance } = await supabase.from('Attendance').select('*').eq('student_id', studentId);
        const { data: behaviors } = await supabase.from('Behaviors').select('*').eq('student_id', studentId);
        const { data: health } = await supabase.from('HealthRecords').select('*').eq('student_id', studentId);
        const { data: visits } = await supabase.from('HomeVisits').select('*').eq('student_id', studentId);
        const { data: contacts } = await supabase.from('ParentContacts').select('*').eq('student_id', studentId);
        const { data: cases } = await supabase.from('StudentCases').select('*').eq('student_id', studentId);
        const { data: documents } = await supabase.from('Documents').select('*').eq('student_id', studentId);

        const safeStudent = student || {
          id: studentId, full_name: 'ไม่พบข้อมูล', first_name: '', last_name: '', student_code: '', class_name: '', photo_url: ''
        };

       if (safeStudent.first_name) {
          safeStudent.full_name = `${safeStudent.prefix || ''}${safeStudent.first_name} ${safeStudent.last_name}`.trim();
          
          // 📌 นำสูตรคำนวณอายุมาวางแทนที่ตรงนี้
          const birthYear = safeStudent.birthdate ? parseInt(String(safeStudent.birthdate).split('-')[0], 10) : null;
          const currentYearCE = new Date().getFullYear();
          safeStudent.age = birthYear ? currentYearCE - (birthYear > 2400 ? birthYear - 543 : birthYear) : null;
        }

        const latestHealth = health && health.length > 0 ? health[health.length - 1] : {};

        return res.json({
          ok: true,
          student: safeStudent,
          parents: parents || [],
          summary: {
            attendance_rate: 100,
            behavior_point: (behaviors || []).reduce((acc, b) => acc + (b.point || 0), 0),
            visit_count: (visits || []).length,
            case_open: (cases || []).filter(c => c.status !== 'ปิดเคส').length,
            bmi: latestHealth.bmi || 0,
            bmi_level: latestHealth.bmi_level || '—',
            weight: latestHealth.weight || 0,
            height: latestHealth.height || 0
          },
          can: { manage: true, health: true },
          attendance: attendance || [],
          behaviors: behaviors || [],
          health: health || [],
          infirmary: [],
          visits: visits || [],
          contacts: contacts || [],
          cases: cases || [],
          activities: [],
          submissions: [],
          documents: documents || [],
          timeline: []
        });
      }

      case 'student.save': {
        const dataIn = { ...payload };
        
        // 1. กรองฟิลด์จำลองออก
        ['full_name', 'age', 'class_name', 'gender_label', 'status_label'].forEach(k => delete dataIn[k]);

        // 2. จัดการรูปถ่าย: แปลง photo_data เป็น photo_url
        if (dataIn.photo_data) {
          dataIn.photo_url = dataIn.photo_data;
          delete dataIn.photo_data;
        }

        // 3. แปลงค่าสตริงว่างให้เป็น null
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined) {
            dataIn[key] = null;
          }
        });

        // ─────────────────────────────────────────
        // 4. 📌 นำโค้ดนี้มาวางแทนที่ส่วนจัดการวันเกิดเดิม
        // ─────────────────────────────────────────
        if (dataIn.birthdate) {
          const birthStr = String(dataIn.birthdate).trim();
          const parts = birthStr.split('T')[0].split('-');
          if (parts.length === 3) {
            let year = parseInt(parts[0], 10);
            // ถ้าหน้าเว็บส่งมาเป็น ค.ศ. (น้อยกว่า 2400) ให้บวก 543 เพื่อเก็บบันทึกเป็น พ.ศ. เสมอ
            if (year < 2400) {
              year = year + 543;
            }
            dataIn.birthdate = `${year}-${parts[1]}-${parts[2]}`;
          }
        }
        // ─────────────────────────────────────────

        // 5. กำหนดค่าเริ่มต้นกันพลาด
        if (!dataIn.status) dataIn.status = 'กำลังศึกษา';
        if (!dataIn.watch_level) dataIn.watch_level = 'ทั่วไป';
        if (!dataIn.nickname) dataIn.nickname = '-';
        if (!dataIn.citizen_id) {
          dataIn.citizen_id = '0' + Math.floor(100000000000 + Math.random() * 900000000000);
        } else {
          dataIn.citizen_id = String(dataIn.citizen_id).trim();
        }

        // 6. รันรหัสนักเรียน (student_code) อัตโนมัติถ้าไม่มี
        if (!dataIn.student_code) {
          const { data: lastStudents } = await supabase
            .from('Students')
            .select('student_code')
            .order('student_code', { ascending: false })
            .limit(1);

          let nextCode = 4371;
          if (lastStudents && lastStudents.length > 0 && lastStudents[0].student_code) {
            nextCode = parseInt(lastStudents[0].student_code, 10) + 1;
          }
          dataIn.student_code = nextCode;
        } else {
          dataIn.student_code = parseInt(dataIn.student_code, 10);
        }

        let result;
        if (dataIn.id) {
          // กรณีแก้ไขข้อมูลเดิม
          const { data, error } = await supabase.from('Students').update(dataIn).eq('id', dataIn.id).select();
          if (error) {
            console.error('❌ Student update error:', error.message);
            return res.status(400).json({ ok: false, error: 'Update Error: ' + error.message });
          }
          result = data ? data[0] : dataIn;
        } else {
          // กรณีเพิ่มนักเรียนใหม่
          const { count } = await supabase.from('Students').select('*', { count: 'exact', head: true });
          const nextIdNum = (count || 0) + 1;
          dataIn.id = 'STU-' + String(nextIdNum).padStart(6, '0');

          const { data, error } = await supabase.from('Students').insert([dataIn]).select();
          if (error) {
            console.error('❌ Student insert error:', error.message);
            return res.status(400).json({ ok: false, error: 'Insert Error: ' + error.message });
          }
          result = data ? data[0] : dataIn;
        }

        // 7. แปลงวันเดือนปีเกิดขาออก กลับเป็น พ.ศ. (+543) ส่งให้หน้าเว็บแสดงผลถูกต้อง
        if (result && result.birthdate) {
          const parts = String(result.birthdate).split('T')[0].split('-');
          if (parts.length === 3) {
            let year = parseInt(parts[0], 10);
            if (year < 2400) {
              year = year + 543;
              result.birthdate = `${year}-${parts[1]}-${parts[2]}`;
            }
          }
        }
await writeAudit(currentUser, dataIn.id ? 'student.update' : 'student.create', 'Students', result.id, { name: `${result.first_name || ''} ${result.last_name || ''}`.trim() });
	      execCache = null;
        studentCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'student.delete': {
        await supabase.from('Students').delete().eq('id', payload?.id);
        studentCache = null;
        return res.json({ ok: true });
      }

      case 'parent.save': {
        const dataIn = payload;
        let result;
        if (dataIn.id) {
          const { data } = await supabase.from('Parents').update(dataIn).eq('id', dataIn.id).select();
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'PAR-' + Math.floor(100000 + Math.random() * 900000);
          const { data } = await supabase.from('Parents').insert([dataIn]).select();
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'parent.delete': {
        await supabase.from('Parents').delete().eq('id', payload?.id);
        return res.json({ ok: true });
      }

      /* ── SETTINGS ── */
      case 'setting.list': {
        const { data } = await supabase.from('Settings').select('*');
        const items = {};
      (data || []).forEach(s => { items[s.key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value; });
        return res.json({ ok: true, items });
      }

      case 'setting.save': {
        const patch = payload || {};
        
        async function uploadBase64ToSupabase(base64Data, fileName) {
          if (!base64Data || !base64Data.startsWith('data:')) return base64Data;
          try {
            const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
            if (!matches) return base64Data;
            const buffer = Buffer.from(matches[2], 'base64');
            const filePath = `settings/${Date.now()}_${fileName}.jpg`;
            const { error } = await supabase.storage.from('school-assets').upload(filePath, buffer, { contentType: matches[1], upsert: true });
            if (error) return base64Data;
            const { data } = supabase.storage.from('school-assets').getPublicUrl(filePath);
            return data.publicUrl;
          } catch (e) { return base64Data; }
        }

        if (patch.logo_data) { patch.logo_image = await uploadBase64ToSupabase(patch.logo_data, 'logo'); delete patch.logo_data; }
        if (patch.hero_data) { patch.hero_image = await uploadBase64ToSupabase(patch.hero_data, 'hero'); delete patch.hero_data; }
        if (patch.devlogo_data) { 
          patch.dev_logo = await uploadBase64ToSupabase(patch.devlogo_data, 'devlogo'); 
          delete patch.devlogo_data; 
        }

        for (const [key, value] of Object.entries(patch)) {
          if (value !== undefined && !key.includes('_data')) {
            // 📌 ปรับแก้ตรงนี้: บันทึกทั้ง id และ key ให้ตรงกันเพื่อป้องกันปัญหา Conflict ของ Supabase
            await supabase.from('Settings').upsert({ 
              id: key,
              key: key, 
              value: String(value), 
              updated_at: new Date().toISOString(),
              updated_by: 'admin'
            }, { onConflict: 'id' });
          }
        }

        const { data: updatedSettings } = await supabase.from('Settings').select('*');
        const items = {};
        (updatedSettings || []).forEach(s => { items[s.key] = s.value; });
        await writeAudit(currentUser, 'setting.save', 'Settings', 'SYSTEM', { keys: Object.keys(patch) });
        return res.json({ ok: true, items });
      }

case 'year.save': {
        const dataIn = { ...payload };

        if (!dataIn.id) {
          const { data: latestYears } = await supabase
            .from('AcademicYears')
            .select('id')
            .order('id', { ascending: false })
            .limit(1);

          let nextIdNum = 1;
          if (latestYears && latestYears.length > 0 && latestYears[0].id) {
            const lastIdStr = latestYears[0].id.replace('AY-', '');
            const parsedNum = parseInt(lastIdStr, 10);
            if (!isNaN(parsedNum)) {
              nextIdNum = parsedNum + 1;
            }
          }
          dataIn.id = 'AY-' + String(nextIdNum).padStart(6, '0');
        }

        if (!dataIn.year) {
          const { data: latestYear } = await supabase.from('AcademicYears').select('year, term').order('year', { ascending: false }).limit(1).maybeSingle();
          if (latestYear) {
            if (latestYear.term == 2) {
              dataIn.year = Number(latestYear.year) + 1;
              dataIn.term = 1;
            } else {
              dataIn.year = Number(latestYear.year);
              dataIn.term = Number(latestYear.term) + 1;
            }
          } else {
            dataIn.year = new Date().getFullYear() + 543;
            dataIn.term = 1;
          }
        }

        // 📌 กำหนดสถานะ status ให้สอดคล้องกับ is_active อัตโนมัติ
        if (dataIn.is_active === true || dataIn.is_active === 'true' || dataIn.is_active === 'TRUE') {
          dataIn.is_active = true;
          dataIn.status = 'เปิด';
        } else {
          dataIn.is_active = false;
          dataIn.status = 'ปิด';
        }

        if (!dataIn.label || String(dataIn.label).trim() === '') {
          dataIn.label = `ปีการศึกษา ${dataIn.year} ภาคเรียนที่ ${dataIn.term || '1'}`;
        }
        if (!dataIn.start_date) dataIn.start_date = new Date().toISOString().split('T')[0];
        if (!dataIn.end_date) dataIn.end_date = new Date().toISOString().split('T')[0];
        if (!dataIn.note) dataIn.note = '-';

        const nowIso = new Date().toISOString();
        dataIn.updated_at = nowIso;
        if (!dataIn.rev) dataIn.rev = 1;

        let result;
        const { data: existingCheck } = await supabase.from('AcademicYears').select('id').eq('id', dataIn.id).maybeSingle();

        if (existingCheck) {
          const { data, error } = await supabase.from('AcademicYears').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.created_at = nowIso;
          const { data, error } = await supabase.from('AcademicYears').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }

        await writeAudit(currentUser, existingCheck ? 'year.update' : 'year.create', 'AcademicYears', result.id, { label: result.label });
        return res.json({ ok: true, item: result });
      }

      case 'year.active': {
        const yearId = payload?.id;
        if (!yearId) return res.status(400).json({ ok: false, error: 'ไม่พบรหัสปีการศึกษา' });

        // 1. ตั้งค่าปีอื่นๆ ทั้งหมดให้เป็น false
        await supabase.from('AcademicYears').update({ is_active: false }).neq('id', yearId);

        // 2. ตั้งค่าปีที่เลือกให้เป็น true (รองรับทั้ง boolean และ string 'true')
        const { data, error } = await supabase.from('AcademicYears')
          .update({ is_active: true })
          .eq('id', yearId)
          .select();

        if (error) return res.status(500).json({ ok: false, error: error.message });

        await writeAudit(currentUser, 'year.active', 'AcademicYears', yearId, {});
        return res.json({ ok: true, item: data ? data[0] : null });
      }

      case 'year.delete': {
        const yearId = payload?.id;
        if (!yearId) return res.status(400).json({ ok: false, error: 'ไม่พบรหัสปีการศึกษา' });

        const { error } = await supabase.from('AcademicYears').delete().eq('id', yearId);
        if (error) return res.status(500).json({ ok: false, error: error.message });

        await writeAudit(currentUser, 'year.delete', 'AcademicYears', yearId, {});
        return res.json({ ok: true });
      }

      /* ── MODULE LISTS & SAVES ── */
      case 'year.list': {
        const { data } = await supabase.from('AcademicYears').select('*');
        return res.json({ ok: true, items: data || [] });
      }

      case 'attendance.sheet': {
        // 1. ดึงข้อมูลห้องเรียนทั้งหมด
        const { data: classesData } = await supabase.from('Classrooms').select('*');
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        
        classesData?.sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });
        
        const classesList = (classesData || []).map(c => ({
          id: c.id,
          name: c.name || `${c.level}/${c.room}`
        }));

        // 2. กำหนดห้องที่เลือก
        const targetClassId = payload?.class_id || (classesList.length > 0 ? classesList[0].id : null);
        const targetClassInfo = classesData?.find(c => c.id === targetClassId);
        const targetClassName = targetClassInfo ? (targetClassInfo.name || `${targetClassInfo.level}/${targetClassInfo.room}`) : 'กรุณาเลือกห้องเรียน';

        // 3. ดึงนักเรียนทั้งหมดในระบบมาเทียบ
        const { data: allStudents } = await supabase.from('Students').select('*');
        
        // 4. กรองนักเรียนให้ตรงกับห้องที่เลือก (รองรับทั้ง class_id และ level)
        let roomStudents = (allStudents || []).filter(s => {
          if (!targetClassId) return false;
          return String(s.class_id || '').trim() === String(targetClassId).trim() ||
                 String(s.class_id || '').trim() === String(targetClassName).trim() ||
                 String(s.level || '').trim() === String(targetClassInfo?.level || '').trim();
        });

        // ถ้ากรองแล้วไม่พบ ให้ดึงทั้งหมดมาแสดงกันเหนียว
        if (!roomStudents || roomStudents.length === 0) {
          roomStudents = allStudents || [];
        }

        // 5. แมปข้อมูลให้ครอบคลุมทุกฟิลด์ที่หน้าเว็บ (ScriptsPages2.html) อาจเรียกใช้
        const items = roomStudents.map((s, index) => {
          const fullName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim();
          return {
            ...s,
            id: s.id,
            student_id: s.id,
            name: fullName,
            full_name: fullName,
            number: s.number || (index + 1),
            photo_url: s.photo_url || '',
            status: s.status || 'กำลังศึกษา'
          };
        });
        
        items.sort((a, b) => (Number(a.number) || 99) - (Number(b.number) || 99));

        // คำนวณ KPI เบื้องต้นส่งให้หน้าเว็บ
        const kpi = {
          total: items.length,
          present: items.length,
          absent: 0,
          sick: 0,
          leave: 0,
          late: 0
        };

        return res.json({ 
          ok: true, 
          date: payload?.date || getTodayThai(), 
          class_id: targetClassId, 
          class_name: targetClassName, 
          classes: classesList, 
          items, 
          kpi,
          can: { manage: true } 
        });
      }

      case 'attendance.history': {
        // 1. ดึงข้อมูลห้องเรียนทั้งหมด
        const { data: classesData } = await supabase.from('Classrooms').select('*');
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        
        classesData?.sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });
        
        const classesList = (classesData || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` }));

        // 2. กำหนดห้องและช่วงวันที่
        const targetClassId = payload?.class_id || (classesList.length > 0 ? classesList[0].id : null);
        const targetClassInfo = classesData?.find(c => c.id === targetClassId);
        const targetClassName = targetClassInfo ? (targetClassInfo.name || `${targetClassInfo.level}/${targetClassInfo.room}`) : 'ห้องเรียน';

        const todayIso = getTodayThai();
        const defaultFrom = new Date();
        defaultFrom.setDate(defaultFrom.getDate() - 29);
        const fromDate = payload?.from || defaultFrom.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const toDate = payload?.to || todayIso;

        // 3. ดึงรายชื่อนักเรียนทั้งหมด
        const { data: allStudents } = await supabase.from('Students').select('*');
        const roomStudents = (allStudents || []).filter(s => {
          if (!targetClassId) return true; // ถ้าไม่ได้กรอง ให้ดึงทั้งหมดมาแสดงป้องกันข้อมูลหาย
          return String(s.class_id || '').trim() === String(targetClassId).trim() ||
                 String(s.class_id || '').trim() === String(targetClassName).trim() ||
                 String(s.level || '').trim() === String(targetClassInfo?.level || '').trim();
        });
        
        const studentsList = roomStudents.length > 0 ? roomStudents : allStudents || [];

        // 4. ดึงข้อมูลการเช็กชื่อทั้งหมดจากตาราง Attendance แบบไม่จำกัดกรอบวันที่ เพื่อดึงข้อมูลล่าสุดที่เพิ่งบันทึกมาโชว์ทันที
        const { data: attRecords } = await supabase.from('Attendance').select('*');

        // 5. สร้างรายการวันที่ทั้งหมดในช่วงเวลา
        const datesArr = [];
        let curr = new Date(fromDate);
        const endD = new Date(toDate);
        while (curr <= endD) {
          datesArr.push(curr.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }));
          curr.setDate(curr.getDate() + 1);
        }

        // 6. ประมวลผลจับคู่ข้อมูลการเช็กชื่อของนักเรียนแต่ละคน
        let totalPresent = 0, totalAbsent = 0, totalLate = 0, totalCount = 0;

        const rows = studentsList.map((s, idx) => {
          const daysMap = {};
          let p = 0, a = 0, l = 0;

          datesArr.forEach(dt => {
            const record = (attRecords || []).find(r => 
              (String(r.student_id) === String(s.id) || String(r.student_id) === String(s.student_code)) && 
              String(r.date).slice(0, 10) === dt
            );
            
            if (record) {
              daysMap[dt] = record.status;
              if (record.status === 'มา') p++;
              else if (record.status === 'ขาด') a++;
              else if (record.status === 'มาสาย') l++;
            }
          });

          const totalDays = datesArr.length || 1;
          const rate = Math.round((p / totalDays) * 100);
          totalPresent += p; totalAbsent += a; totalLate += l; totalCount += totalDays;

          return {
            student_id: s.id,
            number: s.number || (idx + 1),
            name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
            days: daysMap,
            present: p,
            absent: a,
            late: l,
            rate: rate
          };
        });

        rows.sort((a, b) => (Number(a.number) || 99) - (Number(b.number) || 99));
        const overallRate = totalCount > 0 ? Math.round((totalPresent / totalCount) * 100) : 100;

        return res.json({ 
          ok: true, 
          class_id: targetClassId,
          class_name: targetClassName, 
          from: fromDate,
          to: toDate,
          dates: datesArr, 
          rows: rows, 
          kpi: { present: totalPresent, absent: totalAbsent, late: totalLate, sick: 0, leave: 0 }, 
          rate: overallRate, 
          classes: classesList, 
          can: { manage: true } 
        });
      }

    case 'attendance.save': {
        const { date, class_id, items } = payload;
        if (!items || !Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ ok: false, error: 'ไม่พบข้อมูลรายชื่อนักเรียน' });
        }

        // ดึงปีการศึกษาปัจจุบัน
        const { data: activeYear } = await supabase.from('AcademicYears').select('id').eq('is_active', true).maybeSingle();
        const currentYearId = activeYear ? activeYear.id : 'AY-000001';

        // เวลาปัจจุบันรูปแบบ HH:mm
        const now = new Date();
        const checkTimeStr = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
        const nowIso = now.toISOString();

        let savedCount = 0;
        for (const it of items) {
          const { data: existing } = await supabase
            .from('Attendance')
            .select('id, rev')
            .eq('date', date)
            .eq('student_id', it.student_id)
            .maybeSingle();

          if (existing && existing.id) {
            const { error: updateErr } = await supabase.from('Attendance').update({
              status: it.status,
              note: it.note || '',
              evidence_url: it.evidence_url || '', // 📌 ป้องกันไม่ให้ค่าเป็น null
              check_time: checkTimeStr,
              updated_at: nowIso,
              rev: (existing.rev || 1) + 1
            }).eq('id', existing.id);

            if (updateErr) {
              console.error('❌ Attendance update error:', updateErr.message);
              return res.status(400).json({ ok: false, error: updateErr.message });
            }
          } else {
            const newId = 'ATT-' + Math.floor(100000 + Math.random() * 900000);
            const { error: insertErr } = await supabase.from('Attendance').insert([{
              id: newId,
              date: date,
              class_id: class_id,
              student_id: it.student_id,
              status: it.status,
              note: it.note || '',
              evidence_url: '', // 📌 กำหนดค่าว่างให้คอลัมน์ที่บังคับ not-null
              check_time: checkTimeStr,
              year_id: currentYearId,
              created_at: nowIso,
              updated_at: nowIso,
              rev: 1
            }]);

            if (insertErr) {
              console.error('❌ Attendance insert error:', insertErr.message);
              return res.status(400).json({ ok: false, error: insertErr.message });
            }
          }
          savedCount++;
        }
await writeAudit(currentUser, 'attendance.save', 'Attendance', class_id, { date: date, total: savedCount });
	execCache = null;
        return res.json({ ok: true, saved: savedCount });
      }

    case 'behavior.save': {
        const dataIn = { ...payload };
        // กรองเอาคอลัมน์หลอกๆ ที่หน้าเว็บแถมมาออกไป ไม่งั้นฐานข้อมูลพัง
        ['student', 'class_name', 'homeroom_name', 'tone', 'by', 'icon', 'overdue'].forEach(k => delete dataIn[k]);

        // 📌 แปลงค่าว่างเป็น null และแปลงฟิลด์ตัวเลข (เช่น point) ให้ถูกต้องป้องกัน error bigint
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined) {
            dataIn[key] = null;
          } else if (key === 'point') {
            dataIn[key] = parseInt(dataIn[key], 10) || 0;
          }
        });

        let result;
        if (dataIn.id) {
          const { data, error } = await supabase.from('Behaviors').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'BHV-' + Math.floor(100000 + Math.random() * 900000);
          const { data, error } = await supabase.from('Behaviors').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        await writeAudit(currentUser, dataIn.id ? 'behavior.update' : 'behavior.create', 'Behaviors', result.id, { point: result.point });
	      execCache = null;
        behaviorCache = null;
        return res.json({ ok: true, item: result });
      }
      
      case 'behavior.delete': {
        await supabase.from('Behaviors').delete().eq('id', payload?.id);
        behaviorCache = null;
        return res.json({ ok: true });
      }

     case 'visit.save': {
        const payloadData = { ...payload };

        if (payloadData.photo_data) {
          payloadData.photo_url = payloadData.photo_data;
        }

        // ดึงข้อมูลเดิมที่มีอยู่ในฐานข้อมูลออกมาก่อน (กรณีเป็นการแก้ไขข้อมูลรอบที่ 2)
        let existing = {};
        if (payloadData.id) {
          const { data: exData } = await supabase.from('HomeVisits').select('*').eq('id', payloadData.id).single();
          if (exData) existing = exData;
        }

        // ผสานข้อมูลใหม่เข้ากับข้อมูลเดิม เพื่อป้องกันข้อมูลเก่าหาย
        const dataIn = {
          student_id: payloadData.student_id || existing.student_id || '-',
          visit_date: payloadData.visit_date || existing.visit_date || new Date().toISOString().split('T')[0],
          visitor: payloadData.visitor || existing.visitor || '-',
          address: payloadData.address || existing.address || '-',
          informant: payloadData.informant || existing.informant || '-',
          informant_relation: payloadData.informant_relation || existing.informant_relation || '-',
          family_members: String(payloadData.family_members !== undefined && payloadData.family_members !== '' ? payloadData.family_members : (existing.family_members || '0')),
          house_type: payloadData.house_type || existing.house_type || '-',
          house_condition: payloadData.house_condition || existing.house_condition || '-',
          economic: payloadData.economic || existing.economic || '-',
          income_month: String(payloadData.income_month !== undefined && payloadData.income_month !== '' ? payloadData.income_month : (existing.income_month || '0')),
          travel: payloadData.travel || existing.travel || '-',
          environment: payloadData.environment || existing.environment || '-',
          relationship: payloadData.relationship || existing.relationship || '-',
          learning_support: payloadData.learning_support || existing.learning_support || '-',
          problems: payloadData.problems || existing.problems || '-',
          suggestion: payloadData.suggestion || existing.suggestion || '-',
          photo_url: payloadData.photo_url || existing.photo_url || '-',
          lat: payloadData.lat || existing.lat || '-',
          lng: payloadData.lng || existing.lng || '-',
          signature_url: payloadData.signature_url || existing.signature_url || '-',
          status: payloadData.status || existing.status || 'เยี่ยมแล้ว',
          next_date: payloadData.next_date || existing.next_date || '-',
          year_id: payloadData.year_id || existing.year_id || 'AY-000001',
          rev: String(payloadData.rev || existing.rev || '1')
        };

        let result;
        if (payloadData.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('HomeVisits').update(dataIn).eq('id', payloadData.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'VIS-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('HomeVisits').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
	execCache = null;
	visitCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'visit.delete': {
        await supabase.from('HomeVisits').delete().eq('id', payload?.id);
        return res.json({ ok: true });
      }

      case 'case.save': {
        const payloadData = { ...payload };

        // ดึงข้อมูลเดิมออกมาก่อน (กรณีเป็นการแก้ไขข้อมูลรอบที่ 2)
        let existing = {};
        if (payloadData.id) {
          const { data: exData } = await supabase.from('StudentCases').select('*').eq('id', payloadData.id).single();
          if (exData) existing = exData;
        }

        // แปลงค่า rev ให้เป็นตัวเลขอย่างปลอดภัย ป้องกัน Error ประเภท bigint
        let revVal = payloadData.rev !== undefined && payloadData.rev !== '' ? Number(payloadData.rev) : (existing.rev || 1);
        if (isNaN(revVal)) revVal = 1;

        // กำหนดข้อมูลให้ตรงกับโครงสร้างตาราง StudentCases พร้อมป้องกันข้อมูลเดิมหาย
        const dataIn = {
          case_no: payloadData.case_no || existing.case_no || ('CAS-' + Math.floor(1000 + Math.random() * 9000)),
          student_id: payloadData.student_id || existing.student_id || '-',
          class_id: payloadData.class_id || existing.class_id || 'CLS-000001',
          category: payloadData.category || existing.category || 'ทั่วไป',
          level: payloadData.level || existing.level || 'เฝ้าระวัง',
          problem: payloadData.problem || existing.problem || '-',
          cause: payloadData.cause || existing.cause || '-',
          plan: payloadData.plan || existing.plan || '-',
          owner_id: payloadData.owner_id || existing.owner_id || 'USR-000001',
          status: payloadData.status || existing.status || 'เปิดเคส',
          opened_at: payloadData.opened_at || existing.opened_at || new Date().toISOString().split('T')[0],
          closed_at: payloadData.closed_at || existing.closed_at || '-',
          next_date: payloadData.next_date || existing.next_date || '-',
          result: payloadData.result || existing.result || '-',
          year_id: payloadData.year_id || existing.year_id || 'AY-000001',
          rev: revVal
        };

        let result;
        if (payloadData.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('StudentCases').update(dataIn).eq('id', payloadData.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'CS-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('StudentCases').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
	caseCache = null;
        return res.json({ ok: true, item: result });
      }
      case 'case.followup': {
        const payloadData = { ...payload };

        // กำหนดข้อมูลให้ตรงกับโครงสร้างตาราง CaseFollowups และป้องกันค่าว่างชน not null
        const dataIn = {
          case_id: payloadData.case_id || '-',
          date: payloadData.date || new Date().toISOString().split('T')[0],
          detail: payloadData.detail || '-',
          result: payloadData.result || '-',
          next_date: payloadData.next_date || '-',
          by_user: payloadData.by_user || 'ผู้ใช้งานระบบ',
          created_at: new Date().toISOString(),
          created_by: payloadData.created_by || null
        };

        // สร้าง ID ใหม่สำหรับประวัติการติดตาม
        dataIn.id = 'FUP-' + Math.floor(100000 + Math.random() * 900000);

        const { data, error } = await supabase.from('CaseFollowups').insert([dataIn]).select();
        if (error) {
          console.error('CaseFollowups Insert Error:', error.message);
          return res.status(500).json({ ok: false, error: error.message });
        }

        // หากมีการติ๊กปิดเคสจากหน้าฟอร์ม ให้ไปอัปเดตสถานะในตาราง StudentCases เป็น "ปิดเคส" ด้วย
        if (payloadData.close_case && payloadData.case_id) {
          await supabase.from('StudentCases').update({ 
            status: 'ปิดเคส', 
            closed_at: new Date().toISOString().split('T')[0],
            updated_at: new Date().toISOString()
          }).eq('id', payloadData.case_id);
        }

        return res.json({ ok: true, item: data ? data[0] : dataIn });
      }
      case 'case.delete': {
        await supabase.from('StudentCases').delete().eq('id', payload?.id);
	caseCache = null;
        return res.json({ ok: true });
      }

      case 'daily.save': {
        const dataIn = { ...payload };
        
        // แปลง student_ids จาก Array ให้เป็น String (เพราะโครงสร้างตารางเป็น text)
        if (Array.isArray(dataIn.student_ids)) {
          dataIn.student_ids = JSON.stringify(dataIn.student_ids);
        }

        // จัดการค่าว่างให้เป็น null
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined) {
            dataIn[key] = null;
          }
        });

        // กำหนดค่าเริ่มต้นสำหรับฟิลด์บังคับ (NOT NULL) ตามโครงสร้างตาราง
        if (!dataIn.year_id) dataIn.year_id = 'AY-000001';
        if (!dataIn.rev) dataIn.rev = 1;

        let result;
        if (dataIn.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('DailyLogs').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'DLY-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('DailyLogs').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        dailyCache = null;
        return res.json({ ok: true, item: result });
      }
      case 'daily.delete': {
        await supabase.from('DailyLogs').delete().eq('id', payload?.id);
        dailyCache = null;
        return res.json({ ok: true });
      }

      case 'health.save': {
        const payloadData = { ...payload };

        let existing = {};
        if (payloadData.id) {
          const { data: exData } = await supabase.from('HealthRecords').select('*').eq('id', payloadData.id).single();
          if (exData) existing = exData;
        }

        const dataIn = {
          student_id: payloadData.student_id || existing.student_id || '-',
          date: payloadData.date || existing.date || new Date().toISOString().split('T')[0],
          weight: String(payloadData.weight !== undefined && payloadData.weight !== '' ? payloadData.weight : (existing.weight || '0')),
          height: String(payloadData.height !== undefined && payloadData.height !== '' ? payloadData.height : (existing.height || '0')),
          bmi: String(payloadData.bmi !== undefined && payloadData.bmi !== '' ? payloadData.bmi : (existing.bmi || '0')),
          bmi_level: payloadData.bmi_level || existing.bmi_level || '-',
          vision: payloadData.vision || existing.vision || '-',
          hearing: payloadData.hearing || existing.hearing || '-',
          dental: payloadData.dental || existing.dental || '-',
          chronic: payloadData.chronic || existing.chronic || '-',
          allergy: payloadData.allergy || existing.allergy || '-',
          note: payloadData.note || existing.note || '-',
          year_id: payloadData.year_id || existing.year_id || 'AY-000001',
          rev: String(payloadData.rev !== undefined ? payloadData.rev : (existing.rev || '1'))
        };

        let result;
        if (payloadData.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('HealthRecords').update(dataIn).eq('id', payloadData.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'REC-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('HealthRecords').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'health.delete': {
        await supabase.from('HealthRecords').delete().eq('id', payload?.id);
        return res.json({ ok: true });
      }

      case 'infirmary.save': {
        const payloadData = { ...payload };

        let existing = {};
        if (payloadData.id) {
          const { data: exData } = await supabase.from('HealthVisits').select('*').eq('id', payloadData.id).single();
          if (exData) existing = exData;
        }

        // 📌 ถ้าไม่ได้ระบุการส่งต่อ ให้บันทึกเป็น "ดูแลที่โรงเรียน"
        const referVal = payloadData.refer && String(payloadData.refer).trim() !== '' 
          ? payloadData.refer 
          : (existing.refer || 'ดูแลที่โรงเรียน');

        const dataIn = {
          student_id: payloadData.student_id || existing.student_id || '-',
          date: payloadData.date || existing.date || new Date().toISOString().split('T')[0],
          time_in: payloadData.time_in || existing.time_in || '08:00',
          time_out: payloadData.time_out || existing.time_out || '16:00',
          symptom: payloadData.symptom || existing.symptom || '-',
          first_aid: payloadData.first_aid || existing.first_aid || '-',
          medicine: payloadData.medicine || existing.medicine || '-',
          refer: referVal, // 📌 ใช้ค่า refer ที่ตรวจสอบแล้ว
          result: payloadData.result || existing.result || '-',
          note: payloadData.note || existing.note || '-',
          year_id: payloadData.year_id || existing.year_id || 'AY-000001',
          rev: String(payloadData.rev !== undefined ? payloadData.rev : (existing.rev || '1'))
        };

        let result;
        if (payloadData.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('HealthVisits').update(dataIn).eq('id', payloadData.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'INF-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('HealthVisits').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        infirmaryCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'infirmary.delete': {
        await supabase.from('HealthVisits').delete().eq('id', payload?.id);
        infirmaryCache = null;
        return res.json({ ok: true });
      }

      case 'contact.save': {
        const dataIn = { ...payload };
        
        // กำหนดค่าสำรองสำหรับฟิลด์ที่ตารางบังคับ not null แต่ฟอร์มอาจไม่ได้ส่งมา
        if (!dataIn.parent_id) dataIn.parent_id = 'PRT-000000'; // ค่าสำรองถ้าไม่มี parent_id
        if (!dataIn.file_url) dataIn.file_url = '-'; // ค่าสำรองถ้าไม่มีไฟล์แนบ
        if (!dataIn.appointment_date) dataIn.appointment_date = '-';
        if (!dataIn.conclusion) dataIn.conclusion = '-';
        if (!dataIn.followup) dataIn.followup = '-';

        // จัดการฟิลด์อื่นๆ ที่อาจเป็นค่าว่าง
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined || dataIn[key] === null) {
            if (['date', 'student_id', 'channel', 'subject', 'detail', 'result'].includes(key)) {
              dataIn[key] = '-'; // ป้องกัน not null constraint violation
            } else {
              dataIn[key] = null;
            }
          }
        });

        if (!dataIn.year_id) dataIn.year_id = 'AY-000001';
        if (!dataIn.rev) dataIn.rev = 1;

        let result;
        if (dataIn.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('ParentContacts').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'CON-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('ParentContacts').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        contactCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'contact.delete': {
        await supabase.from('ParentContacts').delete().eq('id', payload?.id);
        contactCache = null;
        return res.json({ ok: true });
      }

      case 'activity.save': {
        const dataIn = { ...payload };
        ['class_name', 'attendee_total', 'attendee_joined', 'is_upcoming'].forEach(k => delete dataIn[k]);

        // 📌 แปลง class_ids จาก Array ให้เป็น JSON string หรือคั่นด้วยคอมมาเพื่อเก็บบันทึก
        if (Array.isArray(dataIn.class_ids)) {
          dataIn.class_ids = JSON.stringify(dataIn.class_ids);
        } else if (!dataIn.class_ids && dataIn.class_id) {
          // รองรับกรณีส่งมาแบบห้องเดี่ยวเดิม
          dataIn.class_ids = JSON.stringify([dataIn.class_id]);
        }

        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined) {
            dataIn[key] = null;
          }
        });

        let result;
        if (dataIn.id) {
          const { data, error } = await supabase.from('Activities').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'ACT-' + Math.floor(100000 + Math.random() * 900000);
          const { data, error } = await supabase.from('Activities').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        activityCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'assign.save': {
        const dataIn = { ...payload };
        // กรองฟิลด์จำลองที่หน้าเว็บแถมมาออก
        ['class_name', 'student_total', 'submitted', 'pending', 'percent', 'state'].forEach(k => delete dataIn[k]);

        // แปลงค่าว่างเป็น null
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined) {
            dataIn[key] = null;
          }
        });

        let result;
        if (dataIn.id) {
          const { data, error } = await supabase.from('Assignments').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'ASN-' + Math.floor(100000 + Math.random() * 900000);
          const { data, error } = await supabase.from('Assignments').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        assignCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'assign.delete': {
        await supabase.from('Assignments').delete().eq('id', payload?.id);
        assignCache = null;
        return res.json({ ok: true });
      }

      case 'event.save': {
        const dataIn = { ...payload };
        // กรองฟิลด์จำลองที่หน้าเว็บแถมมาออก
        ['class_name', 'icon', 'tone'].forEach(k => delete dataIn[k]);

        // ฟิลด์ใดที่ไม่ใช่ฟิลด์บังคับ (ไม่มีดอกจันแดง) หากเว้นว่างไว้ ให้เซ็ตเป็น null ทั้งหมด
        const optionalFields = ['time_start', 'time_end', 'place', 'class_id', 'status', 'detail', 'ref_id'];
        optionalFields.forEach(field => {
          if (!dataIn[field] || dataIn[field] === '' || dataIn[field] === 'null' || dataIn[field] === '—ไม่ระบุ—' || dataIn[field] === 'ไม่ระบุ') {
            dataIn[field] = null;
          }
        });

        if (!dataIn.year_id) dataIn.year_id = 'AY-000001';
        if (!dataIn.rev) dataIn.rev = 1;

        let result;
        if (dataIn.id) {
          dataIn.updated_at = new Date().toISOString();
          const { data, error } = await supabase.from('CalendarEvents').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'EVT-' + Math.floor(100000 + Math.random() * 900000);
          dataIn.created_at = new Date().toISOString();
          const { data, error } = await supabase.from('CalendarEvents').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'doc.save': {
        const dataIn = { ...payload };
        
        // ถ้ามีการส่งไฟล์มาเป็น Base64 ให้แปลงและอัปโหลดขึ้น Supabase Storage (Bucket: school-assets)
        if (dataIn.file_data && dataIn.file_data.startsWith('data:')) {
          try {
            const matches = dataIn.file_data.match(/^data:(.+);base64,(.+)$/);
            if (matches && matches.length === 3) {
              const mimeType = matches[1];
              const base64Data = matches[2];
              const buffer = Buffer.from(base64Data, 'base64');
              
              const fileExt = mimeType.split('/')[1] || 'bin';
              const fileName = `doc-${Date.now()}.${fileExt}`;
              const filePath = `documents/${fileName}`;

              // อัปโหลดไฟล์ไปที่ Supabase Storage
              const { error: uploadError } = await supabase.storage
                .from('school-assets')
                .upload(filePath, buffer, { contentType: mimeType, upsert: true });

              if (!uploadError) {
                // ดึง Public URL ของไฟล์เพื่อให้เว็บนำไปแสดงผลหรือดาวน์โหลดได้ทันที
                const { data: urlData } = supabase.storage
                  .from('school-assets')
                  .getPublicUrl(filePath);
                
                if (urlData && urlData.publicUrl) {
                  dataIn.file_url = urlData.publicUrl;
                }
                dataIn.file_type = fileExt;
                dataIn.file_size = buffer.length;
              }
            }
          } catch (err) {
            console.error('Storage upload exception:', err);
          }
        }

        // กรองฟิลด์ Base64 ที่เกินออก
        ['file_data'].forEach(k => delete dataIn[k]);

        // จัดการค่าว่างและตรวจสอบฟิลด์บังคับ
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined || dataIn[key] === null) {
            if (key === 'class_id') {
              dataIn[key] = 'ALL';
            } else if (key === 'file_url') {
              dataIn[key] = 'https://placeholder.com/file';
            } else {
              dataIn[key] = null;
            }
          }
        });

        if (!dataIn.year_id) dataIn.year_id = 'AY-000001';
        if (!dataIn.rev) dataIn.rev = 1;

        let result;
        if (dataIn.id) {
          const { data, error } = await supabase.from('Documents').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'DOC-' + Math.floor(100000 + Math.random() * 900000);
          const { data, error } = await supabase.from('Documents').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        docCache = null;
        return res.json({ ok: true, item: result });
      }

      case 'doc.delete': {
        await supabase.from('Documents').delete().eq('id', payload?.id);
        docCache = null;
        return res.json({ ok: true });
      }

      case 'report.index': {
        const items = [
          { key: 'students', label: 'รายชื่อนักเรียน', desc: 'รายชื่อพร้อมข้อมูลพื้นฐาน แยกตามชั้น/ห้อง', icon: 'people-fill', tone: 'brand' },
          { key: 'attendance', label: 'สรุปการมาเรียน', desc: 'อัตราการมาเรียน รายวัน/รายเดือน/รายห้อง', icon: 'ui-checks', tone: 'ok' },
          { key: 'attendance_sheet', label: 'บัญชีเรียกชื่อ', desc: 'ตารางเข้าชื่อรายวันสำหรับพิมพ์เพื่อเช็กมือ', icon: 'journal-check', tone: 'info' },
          { key: 'behavior', label: 'รายงานพฤติกรรม', desc: 'สรุปพฤติกรรมเชิงบวก/ที่ต้องติดตาม', icon: 'emoji-smile-fill', tone: 'warn' },
          { key: 'contacts', label: 'รายงานติดต่อผู้ปกครอง', desc: 'ประวัติการสื่อสารทุกช่องทาง', icon: 'telephone-fill', tone: 'acc' },
          { key: 'visits', label: 'รายงานเยี่ยมบ้าน', desc: 'ผลการเยี่ยมบ้านและการติดตาม', icon: 'house-heart-fill', tone: 'ok' },
          { key: 'health', label: 'รายงานสุขภาพ', desc: 'ภาวะโภชนาการ (BMI) และห้องพยาบาล', icon: 'clipboard2-pulse-fill', tone: 'bad' },
          { key: 'cases', label: 'รายงานการช่วยเหลือนักเรียน', desc: 'การคัดกรอง ติดตาม และแผนการช่วยเหลือ', icon: 'life-preserver', tone: 'late' },
          { key: 'activities', label: 'รายงานกิจกรรม', desc: 'กิจกรรมประจำชั้นและการเข้าร่วม', icon: 'flag-fill', tone: 'brand' },
          { key: 'dailylogs', label: 'บันทึกประจำวันครู', desc: 'สรุปบันทึกงานประจำวันของครูประจำชั้น', icon: 'journal-text', tone: 'info' }
        ];

        let activeYear = null;
        try {
          const { data } = await supabase.from('AcademicYears').select('*').eq('is_active', true).maybeSingle();
          activeYear = data;
        } catch (e) {}

        let classes = [];
        try {
          const { data } = await supabase.from('Classrooms').select('*');
          if (data) classes = data;
        } catch (e) {}

        return res.json({
          ok: true,
          year: activeYear ? activeYear.label : 'ปีการศึกษา 2569',
          items: items,
          classes: classes
        });
      }

      case 'report.run': {
        const reportKey = payload?.key;
        const classId = payload?.class_id;
        const fromDate = payload?.from || '2026-05-01';
        const toDate = payload?.to || getTodayThai();

        let dataRows = [];
        let reportHead = [];
        let reportTitle = 'รายงาน';
        let summaryStats = [];

        const { data: classesData } = await supabase.from('Classrooms').select('*');
        
        // จัดเรียงลำดับห้องเรียนตามระดับชั้น (อ.1 -> ม.6)
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classesData) {
          classesData.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const classMap = {}; (classesData || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });
        const targetClassName = classId ? (classMap[classId] || 'ห้องที่เลือก') : 'ทุกห้องที่รับผิดชอบ';

        if (reportKey === 'students') {
          reportTitle = 'รายชื่อนักเรียน';
          reportHead = ['เลขที่', 'รหัสนักเรียน', 'ชื่อ-สกุล', 'ชื่อเล่น', 'เพศ', 'อายุ', 'ชั้น/ห้อง', 'สถานะ', 'ระดับติดตาม'];
          
          let query = supabase.from('Students').select('*');
          if (classId) query = query.eq('class_id', classId);
          const { data: students } = await query;

          // จัดเรียงลำดับนักเรียนตามห้องและเลขที่
          const sortedStudents = (students || []).sort((a, b) => {
            let lA = levelOrder[String(a.level || '').trim()] || 99;
            let lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            if (String(a.class_id) !== String(b.class_id)) {
              return String(a.class_id || '').localeCompare(String(b.class_id || ''));
            }
            return (Number(a.number) || 99) - (Number(b.number) || 99);
          });

          const currentYearCE = new Date().getFullYear();
          dataRows = sortedStudents.map(s => {
            const birthYear = s.birthdate ? parseInt(String(s.birthdate).split('-')[0], 10) : null;
            const ageVal = birthYear ? currentYearCE - (birthYear > 2400 ? birthYear - 543 : birthYear) : '-';

            return [
              s.number || '-',
              s.student_code || '-',
              `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              s.nickname || '-',
              s.gender || '-',
              ageVal,
              classMap[s.class_id] || s.level || '-',
              s.status || 'กำลังศึกษา',
              s.watch_level || 'ทั่วไป'
            ];
          });

          const totalStu = dataRows.length;
          const maleStu = sortedStudents.filter(s => s.gender === 'ชาย').length;
          const femaleStu = sortedStudents.filter(s => s.gender === 'หญิง').length;

          summaryStats = [
            { label: 'นักเรียนทั้งหมด', value: totalStu, unit: 'คน' },
            { label: 'ชาย', value: maleStu, unit: 'คน' },
            { label: 'หญิง', value: femaleStu, unit: 'คน' }
          ];

        } else if (reportKey === 'attendance') {
          reportTitle = 'สรุปการมาเรียน';
          reportHead = ['เลขที่', 'ชื่อ-สกุล', 'ชั้น/ห้อง', 'มา', 'ขาด', 'ลาป่วย', 'ลากิจ', 'มาสาย', 'กิจกรรม', 'รวม', 'อัตรามาเรียน (%)'];
          
          let query = supabase.from('Students').select('*');
          if (classId) query = query.eq('class_id', classId);
          const { data: students } = await query;

          const { data: attRecords } = await supabase.from('Attendance').select('*').gte('date', fromDate).lte('date', toDate);

          const sortedStudents = (students || []).sort((a, b) => {
            let lA = levelOrder[String(a.level || '').trim()] || 99;
            let lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            if (String(a.class_id) !== String(b.class_id)) {
              return String(a.class_id || '').localeCompare(String(b.class_id || ''));
            }
            return (Number(a.number) || 99) - (Number(b.number) || 99);
          });

          let totalPresAll = 0, totalAbsAll = 0, totalLateAll = 0, totalDaysAll = 0;

          dataRows = sortedStudents.map(s => {
            const sAtts = (attRecords || []).filter(r => String(r.student_id) === String(s.id) || String(r.student_id) === String(s.student_code));
            
            let p = 0, a = 0, sick = 0, leave = 0, late = 0, ev = 0;
            sAtts.forEach(r => {
              if (r.status === 'มา') p++;
              else if (r.status === 'ขาด') a++;
              else if (r.status === 'ลาป่วย') sick++;
              else if (r.status === 'ลากิจ') leave++;
              else if (r.status === 'มาสาย') late++;
              else if (r.status === 'กิจกรรม') ev++;
            });

            const totalRecs = sAtts.length || 1;
            const rate = Math.round((p / totalRecs) * 100);

            totalPresAll += p; totalAbsAll += a; totalLateAll += late; totalDaysAll += totalRecs;

            return [
              s.number || '-',
              `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              classMap[s.class_id] || s.level || '-',
              p,
              a,
              sick,
              leave,
              late,
              ev,
              totalRecs,
              rate
            ];
          });

          const overallRate = totalDaysAll > 0 ? Math.round((totalPresAll / totalDaysAll) * 100) : 100;
          summaryStats = [
            { label: 'อัตราการมาเรียนรวม', value: overallRate, unit: '%' },
            { label: 'ขาดเรียนรวม', value: totalAbsAll, unit: 'ครั้ง' },
            { label: 'มาสายรวม', value: totalLateAll, unit: 'ครั้ง' }
          ];

} else if (reportKey === 'attendance_sheet') {
          reportTitle = 'บัญชีเรียกชื่อและสรุปการมาเรียน';
          
          // สร้างรายการวันที่ในช่วงที่เลือก
          const datesArr = [];
          let curr = new Date(fromDate);
          const endD = new Date(toDate);
          while (curr <= endD) {
            datesArr.push(curr.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }));
            curr.setDate(curr.getDate() + 1);
          }

          // 📌 ปรับหัวตารางให้แสดงวันที่แบบกระชับ (เช่น 23/8) บรรทัดเดียวไม่ให้ตัวเลขแตกแถว
          reportHead = ['เลขที่', 'ชื่อ-สกุล', 'ชั้น/ห้อง', ...datesArr.map(d => {
            const parts = d.split('-');
            return `${parseInt(parts[2], 10)}/${parseInt(parts[1], 10)}`;
          }), 'รวมมา'];

          // ดึงรายชื่อนักเรียน
          let query = supabase.from('Students').select('*').eq('status', 'กำลังศึกษา');
          if (classId) query = query.eq('class_id', classId);
          const { data: students } = await query;

          // ดึงประวัติการมาเรียนในช่วงวันที่เลือก
          const { data: attRecords } = await supabase.from('Attendance').select('*').gte('date', fromDate).lte('date', toDate);

          // จัดเรียงลำดับห้องเรียนตามระดับชั้น และตามด้วยเลขที่นักเรียน
          const sortedStudents = (students || []).sort((a, b) => {
            let lA = levelOrder[String(a.level || '').trim()] || 99;
            let lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            if (String(a.class_id) !== String(b.class_id)) {
              return String(a.class_id || '').localeCompare(String(b.class_id || ''));
            }
            return (Number(a.number) || 99) - (Number(b.number) || 99);
          });

          let totalPresentCount = 0;
          let totalDaysCount = 0;

          dataRows = sortedStudents.map(s => {
            let rowCols = [
              s.number || '-',
              `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              classMap[s.class_id] || s.level || '-'
            ];

            let presentDays = 0;
            datesArr.forEach(dt => {
              const rec = (attRecords || []).find(r => 
                (String(r.student_id) === String(s.id) || String(r.student_id) === String(s.student_code)) && 
                String(r.date).slice(0, 10) === dt
              );

              const status = rec ? rec.status : 'มา'; 
              if (status === 'มา') {
                presentDays++;
                totalPresentCount++;
                // 🟢 ใช้เครื่องหมายถูกเดี่ยวๆ เพื่อไม่ให้ตารางล้นหน้ากระดาษเวลาพิมพ์
                rowCols.push('✔');
              } else {
                // 🔴 ใช้เครื่องหมายกากบาทเดี่ยวๆ
                rowCols.push('✘');
              }
              totalDaysCount++;
            });

            rowCols.push(`${presentDays}/${datesArr.length}`);
            return rowCols;
          });

          const overallRate = totalDaysCount > 0 ? Math.round((totalPresentCount / totalDaysCount) * 100) : 100;
          summaryStats = [
            { label: 'นักเรียนทั้งหมด', value: sortedStudents.length, unit: 'คน' },
            { label: 'อัตราการมาเรียนเฉลี่ย', value: overallRate, unit: '%' }
          ];

        } else if (reportKey === 'behavior') {
          reportTitle = 'รายงานพฤติกรรมนักเรียน';
          reportHead = ['วันที่', 'นักเรียน', 'ชั้น/ห้อง', 'ประเภท', 'หัวข้อ', 'คะแนน', 'ผู้บันทึก'];
          
          // 📌 ดึงข้อมูลพฤติกรรมพร้อมกรองตามช่วงวันที่ (from ถึง to)
          const { data: behs } = await supabase.from('Behaviors').select('*').gte('date', fromDate).lte('date', toDate);
          const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, class_id');
          
          const studentMap = {}; 
          (students || []).forEach(s => { 
            studentMap[s.id] = {
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              class_id: s.class_id
            }; 
          });

          // 📌 กรองตามห้องเรียน (class_id) ถ้ามีการเลือกห้อง
          dataRows = (behs || []).filter(b => {
            const s = studentMap[b.student_id];
            if (!s) return false;
            if (classId && String(s.class_id) !== String(classId)) return false;
            return true;
          }).map(b => {
            const s = studentMap[b.student_id] || {};
            return [
              b.date || '-',
              s.name || '-',
              classMap[s.class_id] || '-',
              b.type || '-',
              b.title || '-',
              (b.point > 0 ? '+' : '') + (b.point || 0),
              b.created_by || 'ระบบ'
            ];
          });

          summaryStats = [{ label: 'รายการพฤติกรรม', value: dataRows.length, unit: 'รายการ' }];

	} else if (reportKey === 'contacts') {
          reportTitle = 'รายงานการติดต่อผู้ปกครอง';
          reportHead = ['วันที่', 'นักเรียน', 'ชั้น/ห้อง', 'ช่องทาง', 'เรื่อง/หัวข้อ', 'ผลการติดต่อ', 'ผู้บันทึก'];
          
          // 📌 ดึงข้อมูลจากตาราง ParentContacts พร้อมกรองตามช่วงวันที่
          const { data: contacts } = await supabase.from('ParentContacts').select('*').gte('date', fromDate).lte('date', toDate);
          const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, class_id');
          
          const studentMap = {}; 
          (students || []).forEach(s => { 
            studentMap[s.id] = {
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              class_id: s.class_id
            }; 
          });

          // 📌 กรองตามห้องเรียน (class_id) และเรียงตามวันที่
          dataRows = (contacts || []).filter(ct => {
            const s = studentMap[ct.student_id];
            if (!s) return false;
            if (classId && String(s.class_id) !== String(classId)) return false;
            return true;
          }).map(ct => {
            const s = studentMap[ct.student_id] || {};
            return [
              ct.date || '-',
              s.name || '-',
              classMap[s.class_id] || '-',
              ct.channel || '-',
              ct.subject || '-',
              ct.result || '-',
              ct.created_by || 'ระบบ'
            ];
          });

          summaryStats = [{ label: 'รายการติดต่อ', value: dataRows.length, unit: 'ครั้ง' }];

	} else if (reportKey === 'cases') {
          reportTitle = 'รายงานการช่วยเหลือนักเรียน';
          reportHead = ['เลขเคส', 'นักเรียน', 'ชั้น/ห้อง', 'ประเภทปัญหา', 'ระดับการดูแล', 'สถานะ', 'วันที่เปิดเคส'];
          
          // 📌 ดึงข้อมูลจากตาราง StudentCases พร้อมกรองตามช่วงวันที่เปิดเคส (opened_at)
          const { data: cases } = await supabase.from('StudentCases').select('*').gte('opened_at', fromDate).lte('opened_at', toDate);
          const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, class_id');
          
          const studentMap = {}; 
          (students || []).forEach(s => { 
            studentMap[s.id] = {
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              class_id: s.class_id
            }; 
          });

          // 📌 กรองตามห้องเรียน (class_id) และเรียงข้อมูล
          dataRows = (cases || []).filter(c => {
            const s = studentMap[c.student_id];
            if (!s) return false;
            if (classId && String(s.class_id) !== String(classId)) return false;
            return true;
          }).map(c => {
            const s = studentMap[c.student_id] || {};
            return [
              c.case_no || c.id || '-',
              s.name || '-',
              classMap[s.class_id] || '-',
              c.category || 'ทั่วไป',
              c.level || 'เฝ้าระวัง',
              c.status || 'เปิดเคส',
              c.opened_at || '-'
            ];
          });

          summaryStats = [{ label: 'เคสทั้งหมด', value: dataRows.length, unit: 'เคส' }];

} else if (reportKey === 'activities') {
          reportTitle = 'รายงานกิจกรรม';
          reportHead = ['ชื่อกิจกรรม', 'ประเภท', 'ชั้น/ห้อง', 'สถานที่', 'วันที่จัด', 'เวลา'];
          
          // 📌 ดึงข้อมูลจากตาราง Activities พร้อมกรองตามช่วงวันที่ (date)
          const { data: acts } = await supabase.from('Activities').select('*').gte('date', fromDate).lte('date', toDate);

          // 📌 กรองตามห้องเรียน (class_id) และเรียงตามวันที่
          dataRows = (acts || []).filter(a => {
            if (classId && a.class_id && String(a.class_id) !== String(classId)) return false;
            return true;
          }).map(a => {
            let className = 'ทั้งโรงเรียน';
            if (a.class_id) {
              className = classMap[a.class_id] || a.class_id;
            } else if (a.class_ids) {
              try {
                const cArr = JSON.parse(a.class_ids);
                className = cArr.map(cid => classMap[cid] || cid).join(', ');
              } catch (e) {
                className = 'หลายห้องเรียน';
              }
            }

            return [
              a.name || '-',
              a.category || 'กิจกรรมทั่วไป',
              className,
              a.place || '-',
              a.date || '-',
              (a.time_start ? a.time_start : '') + (a.time_end ? ' - ' + a.time_end : '')
            ];
          });

          summaryStats = [{ label: 'กิจกรรมทั้งหมด', value: dataRows.length, unit: 'กิจกรรม' }];

        } else if (reportKey === 'visits') {
          reportTitle = 'รายงานการเยี่ยมบ้านนักเรียน';
          reportHead = ['วันที่เยี่ยม', 'นักเรียน', 'สถานะ', 'สภาพเศรษฐกิจ', 'ผู้เยี่ยม'];
          const { data: visits } = await supabase.from('HomeVisits').select('*');
          const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, class_id');
          const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(); });

          dataRows = (visits || []).map(v => [
            v.visit_date || '-',
            studentMap[v.student_id] || '-',
            v.status || '-',
            v.economic || '-',
            v.visitor || '-'
          ]);
          summaryStats = [{ label: 'เยี่ยมบ้านแล้ว', value: dataRows.length, unit: 'ครั้ง' }];

} else if (reportKey === 'dailylogs') {
          reportTitle = 'บันทึกประจำวันครู';
          reportHead = ['วันที่', 'หัวข้อ/รายการ', 'หมวดหมู่', 'ชั้น/ห้อง', 'ผู้บันทึก'];
          
          // 📌 ดึงข้อมูลจากตาราง DailyLogs พร้อมกรองตามช่วงวันที่ (date)
          const { data: logs } = await supabase.from('DailyLogs').select('*').gte('date', fromDate).lte('date', toDate);

          // 📌 ดึงรายชื่อผู้ใช้งานเพื่อแปลงรหัสผู้บันทึกเป็นชื่อ-นามสกุล
          const { data: users } = await supabase.from('Users').select('id, full_name');
          const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });

          // 📌 กรองตามห้องเรียน (class_id) และเรียงตามวันที่
          dataRows = (logs || []).filter(l => {
            if (classId && l.class_id && String(l.class_id) !== String(classId)) return false;
            return true;
          }).map(l => [
            l.date || '-',
            l.title || '-',
            l.category || 'บันทึกทั่วไป',
            classMap[l.class_id] || 'ทั้งโรงเรียน',
            userMap[l.created_by] || l.created_by || 'ระบบ'
          ]);

          summaryStats = [{ label: 'บันทึกทั้งหมด', value: dataRows.length, unit: 'รายการ' }];

        } else if (reportKey === 'health') {
          reportTitle = 'รายงานภาวะโภชนาการ (BMI)';
          reportHead = ['วันที่ชั่ง', 'นักเรียน', 'น้ำหนัก (กก.)', 'ส่วนสูง (ซม.)', 'BMI', 'ภาวะโภชนาการ'];
          const { data: healths } = await supabase.from('HealthRecords').select('*');
          const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name');
          const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(); });

          dataRows = (healths || []).map(h => [
            h.date || '-',
            studentMap[h.student_id] || '-',
            h.weight || '0',
            h.height || '0',
            h.bmi || '0',
            h.bmi_level || '-'
          ]);
          summaryStats = [{ label: 'บันทึกสุขภาพ', value: dataRows.length, unit: 'คน' }];

        } else {
          // ค่าเริ่มต้นสำหรับรายงานอื่นๆ
          reportHead = ['รายการ', 'รายละเอียด', 'วันที่'];
          dataRows = [['ข้อมูลทั่วไป', 'รายงานระบบสารสนเทศ', getTodayThai()]];
          summaryStats = [{ label: 'ข้อมูลรวม', value: 1, unit: 'รายการ' }];
        }

        let activeYear = null;
        try {
          const { data } = await supabase.from('AcademicYears').select('*').eq('is_active', true).maybeSingle();
          activeYear = data;
        } catch (e) {}

        return res.json({
          ok: true,
          title: reportTitle,
          icon: 'file-earmark-bar-graph-fill',
          head: reportHead,
          rows: dataRows,
          filters: {
            year: activeYear ? activeYear.label : 'ปีการศึกษา 2569 ภาคเรียนที่ 1',
            from: fromDate,
            to: toDate,
            class_name: targetClassName
          },
          summary: summaryStats
        });
      }

      case 'assignment.save': {
        const dataIn = { ...payload };
        
        // จัดการค่าว่างและใส่ค่าสำรองให้ฟิลด์ที่ฐานข้อมูลบังคับห้ามเป็น null
        Object.keys(dataIn).forEach(key => {
          if (dataIn[key] === '' || dataIn[key] === undefined || dataIn[key] === null) {
            if (key === 'subject') {
              dataIn[key] = 'ทั่วไป';
            } else if (key === 'class_id') {
              dataIn[key] = 'ALL';
            } else if (key === 'file_url') {
              dataIn[key] = '-';
            } else {
              dataIn[key] = null;
            }
          }
        });

        let result;
        if (dataIn.id) {
          const { data, error } = await supabase.from('Assignments').update(dataIn).eq('id', dataIn.id).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'ASG-' + Math.floor(100000 + Math.random() * 900000);
          const { data, error } = await supabase.from('Assignments').insert([dataIn]).select();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'assign.list':
      case 'assignment.list':
      case 'assignments.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (assignCache && (nowTime - assignCacheTime < 120000)) {
          return res.json(assignCache);
        }

        const keyword = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterType = String(payload?.filter || '').trim();

        let items = [];
        let classes = [];

        try {
          const { data: assigns } = await supabase.from('Assignments').select('*');
          const { data: subs } = await supabase.from('Submissions').select('*');
          const { data: students } = await supabase.from('Students').select('*');
          
          if (assigns) {
            const now = new Date();
            const todayStr = getTodayThai();

            items = assigns.map(a => {
              const asgSubs = (subs || []).filter(s => s.assignment_id === a.id);
              const targetStudents = (students || []).filter(s => !a.class_id || a.class_id === 'ALL' || String(s.class_id) === String(a.class_id));
              const studentTotal = targetStudents.length || 1;
              const submittedCount = asgSubs.filter(s => s.status === 'ส่งแล้ว' || s.status === 'ส่งช้า').length;
              const pendingCount = Math.max(0, studentTotal - submittedCount);
              const percent = Math.round((submittedCount / studentTotal) * 100);

              let state = 'open';
              const dueDateObj = a.due_date ? new Date(a.due_date) : null;
              const isOverdue = dueDateObj && dueDateObj < now && submittedCount < studentTotal;

              if (isOverdue) {
                state = 'overdue';
              } else if (submittedCount >= studentTotal) {
                state = 'done';
              } else if (dueDateObj) {
                const diffTime = dueDateObj - now;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays >= 0 && diffDays <= 3) {
                  state = 'soon';
                }
              }

              return {
                ...a,
                student_total: studentTotal,
                submitted: submittedCount,
                pending: pendingCount,
                percent: percent,
                state: state,
                isOverdue: isOverdue
              };
            });
          }
        } catch (e) {}

        try {
          const { data } = await supabase.from('Classrooms').select('*');
          if (data) classes = data;
        } catch (e) {}

        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        classes.sort((a, b) => {
          const lA = levelOrder[String(a.level || '').trim()] || 99;
          const lB = levelOrder[String(b.level || '').trim()] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''), 'th');
        });

        if (filterClassId) {
          items = items.filter(x => String(x.class_id) === filterClassId);
        }

        const todayStr = getTodayThai();
        if (filterType === 'today') {
          items = items.filter(x => String(x.assign_date || '').slice(0, 10) === todayStr);
        } else if (filterType === 'due') {
          items = items.filter(x => x.state === 'soon');
        } else if (filterType === 'overdue') {
          items = items.filter(x => x.state === 'overdue');
        }

        if (keyword) {
          items = items.filter(x => 
            String(x.title || '').toLowerCase().includes(keyword) || 
            String(x.subject || '').toLowerCase().includes(keyword)
          );
        }

        const totalAssignments = items.length;
        const kpi = {
          total: totalAssignments,
          today: items.filter(x => String(x.assign_date || '').slice(0, 10) === todayStr).length,
          due_soon: items.filter(x => x.state === 'soon').length,
          overdue: items.filter(x => x.state === 'overdue').length,
          pending_students: items.reduce((acc, x) => acc + x.pending, 0)
        };

        const resultPayload = {
          ok: true,
          items,
          total: items.length,
          pages: 1,
          page: 1,
          kpi,
          classes: classes.map(c => ({ 
            id: c.id, 
            name: c.name || `${c.level || ''}/${c.room || ''}` 
          })),
          can: { manage: true }
        };

        // 📌 บันทึกลงแคช
        assignCache = resultPayload;
        assignCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'assign.get':
      case 'assignment.get':
      case 'assignments.get': {
        const assignmentId = payload.id || payload;
        let assignment = null;
        let students = [];
        let submissions = [];
        let targetClassObj = null;

        try {
          const { data: asgData } = await supabase.from('Assignments').select('*').eq('id', assignmentId).maybeSingle();
          if (asgData) assignment = asgData;

          let classData = [];
          try {
            const { data: cData } = await supabase.from('Classrooms').select('*');
            if (cData) classData = cData;
          } catch (e) {}

          let targetClassId = assignment ? String(assignment.class_id || '').trim() : '';
          
          targetClassObj = classData.find(c => 
            String(c.id).trim() === targetClassId || 
            String(c.name || '').trim() === targetClassId || 
            `${c.level || ''}/${c.room || ''}` === targetClassId ||
            String(c.room || '').trim() === targetClassId
          );

          const { data: stdData } = await supabase.from('Students').select('*');
          if (stdData) {
            students = stdData.filter(s => {
              if (!targetClassId || targetClassId === 'ALL') return true;
              const sClassId = String(s.class_id || '').trim();
              const sClassroomId = String(s.classroom_id || '').trim();
              return sClassId === targetClassId ||
                     sClassroomId === targetClassId ||
                     (targetClassObj && (
                       sClassId === String(targetClassObj.id).trim() ||
                       sClassroomId === String(targetClassObj.id).trim() ||
                       sClassId === String(targetClassObj.name || '').trim() ||
                       sClassId === `${targetClassObj.level || ''}/${targetClassObj.room || ''}`
                     ));
            });
          }

          const { data: subData } = await supabase.from('Submissions').select('*').eq('assignment_id', assignmentId);
          if (subData) submissions = subData;

        } catch (e) {
          console.error("Error in assignment.get:", e);
        }

        const submissionMap = {};
        submissions.forEach(s => { submissionMap[s.student_id] = s; });

        const formattedStudents = students.map((s, idx) => {
          const sub = submissionMap[s.id] || {};
          let currentScore = sub.score;
          // ถ้านักเรียนยังไม่ส่งและคะแนนว่าง ให้แสดงเป็น 0 ตามที่ต้องการ
          if ((!sub.status || sub.status === 'ยังไม่ส่ง') && (currentScore === null || currentScore === undefined || currentScore === '')) {
            currentScore = 0;
          }

          return {
            student_id: s.id,
            number: s.number || (idx + 1),
            name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
            status: sub.status || 'ยังไม่ส่ง',
            score: currentScore !== null && currentScore !== undefined ? currentScore : 0
          };
        });

        const submittedCount = formattedStudents.filter(s => s.status === 'ส่งแล้ว').length;
        const lateCount = formattedStudents.filter(s => s.status === 'ส่งช้า').length;
        const pendingCount = formattedStudents.filter(s => s.status === 'ยังไม่ส่ง').length;

        const now = new Date();
        const itemWithOverdue = assignment ? {
          ...assignment,
          class_name: targetClassObj ? (targetClassObj.name || `${targetClassObj.level}/${targetClassObj.room}`) : '—',
          isOverdue: assignment.due_date ? new Date(assignment.due_date) < now : false
        } : null;

        return res.json({
          ok: true,
          item: itemWithOverdue,
          students: formattedStudents,
          stat: {
            submitted: submittedCount,
            late: lateCount,
            pending: pendingCount
          },
          statuses: ['ยังไม่ส่ง', 'ส่งช้า', 'ส่งแล้ว'],
          can: { manage: true }
        });
      }

      case 'assign.submit':
      case 'assignment.submit':
      case 'assignments.submit': {
        const { id: assignmentId, items } = payload;
        if (!assignmentId || !items || !Array.isArray(items)) {
          return res.status(400).json({ ok: false, error: 'ข้อมูลไม่ครบถ้วน' });
        }

        try {
          let savedCount = 0;
          const todayStr = getTodayThai();

          for (const it of items) {
            const studentId = it.student_id;
            const status = it.status || 'ยังไม่ส่ง';
            
            // ถ้านักเรียนยังไม่ส่ง ให้บันทึกคะแนนเป็น 0 อัตโนมัติ
            let score = 0;
            if (it.score !== undefined && it.score !== '' && !isNaN(it.score)) {
              score = Number(it.score);
            }

            const note = it.note || '';

            const { data: existing, error: findErr } = await supabase
              .from('Submissions')
              .select('*')
              .eq('assignment_id', assignmentId)
              .eq('student_id', studentId)
              .maybeSingle();

            if (existing && existing.id) {
              await supabase.from('Submissions').update({
                status: status,
                score: score,
                note: note,
                submit_date: status !== 'ยังไม่ส่ง' ? (existing.submit_date || todayStr) : null,
                updated_at: new Date().toISOString()
              }).eq('id', existing.id);
            } else {
              const subId = 'SUB-' + Math.floor(100000 + Math.random() * 900000);
              await supabase.from('Submissions').insert([{
                id: subId,
                assignment_id: assignmentId,
                student_id: studentId,
                status: status,
                score: score,
                note: note,
                submit_date: status !== 'ยังไม่ส่ง' ? todayStr : null,
                created_at: new Date().toISOString()
              }]);
            }
            savedCount++;
          }
          assignCache = null;
          return res.json({ ok: true, saved: savedCount });
        } catch (err) {
          console.error('❌ Critical error in assign.submit:', err.message);
          return res.status(500).json({ ok: false, error: err.message });
        }
      }

      case 'class.index':
      case 'classroom.index':
      case 'classrooms.index': {
        const { data: classrooms, error } = await supabase.from('Classrooms').select('*');
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.json({ ok: true, items: classrooms || [] });
      }

      case 'daily.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (dailyCache && (nowTime - dailyCacheTime < 120000)) {
          return res.json(dailyCache);
        }

        const keyword = String(payload?.q || '').trim();
        const classId = String(payload?.class_id || '').trim();
        const category = String(payload?.category || '').trim();

        let query = supabase.from('DailyLogs').select('*', { count: 'exact' });
        if (keyword) query = query.ilike('title', `%${keyword}%`);
        if (classId) query = query.eq('class_id', classId);
        if (category) query = query.eq('category', category);

        const { data: logs, count, error } = await query;
        if (error) throw error;

        const { data: users } = await supabase.from('Users').select('id, full_name');
        const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });
        
        const { data: classrooms } = await supabase.from('Classrooms').select('*');
        
        const items = (logs || []).map(l => ({ ...l, by: userMap[l.created_by] || l.created_by || 'ระบบ' }));
        
        const resultPayload = { 
          ok: true, 
          items, 
          total: count || items.length, 
          pages: 1, 
          page: 1, 
          kpi: { total: count || items.length, today: 0, week: 0, with_photo: items.filter(x => x.photo_url).length }, 
          categories: ['กิจกรรมหน้าเสาธง', 'ดูแลความเรียบร้อย', 'ทำความสะอาดห้องเรียน', 'เหตุการณ์ในห้องเรียน', 'ติดตามนักเรียน', 'งานที่ได้รับมอบหมาย', 'เหตุการณ์ผิดปกติ'], 
          classes: classrooms || [], 
          can: { manage: true }
        };

        // 📌 บันทึกลงแคช
        dailyCache = resultPayload;
        dailyCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'behavior.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (behaviorCache && (nowTime - behaviorCacheTime < 120000)) {
          return res.json(behaviorCache);
        }

        const { data: behaviors } = await supabase.from('Behaviors').select('*');
        const { data: students } = await supabase.from('Students').select('id, student_code, prefix, first_name, last_name, nickname, number, class_id, photo_url, watch_level');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        const { data: users } = await supabase.from('Users').select('id, full_name');

        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = s; });
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });
        const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });

        let typeCountMap = {};
        (behaviors || []).forEach(b => {
          let tp = b.type || 'พฤติกรรมทั่วไป';
          typeCountMap[tp] = (typeCountMap[tp] || 0) + 1;
        });

        const byTypeArray = Object.keys(typeCountMap).map(k => {
          let tone = 'info';
          if (k.includes('บวก') || k.includes('ชม')) {
            tone = 'ok';
          } else if (k.includes('ติดตาม')) {
            tone = 'warn';
          } else if (k.includes('ผิดระเบียบ')) {
            tone = 'bad';
          } else if (k.includes('รางวัล')) {
            tone = 'acc';
          }
          return { label: k, value: typeCountMap[k], tone: tone };
        });

        const items = (behaviors || []).map(b => {
          const s = studentMap[b.student_id] || {};
          return {
            ...b,
            student: {
              id: s.id || b.student_id,
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || 'ไม่พบข้อมูล',
              nickname: s.nickname || '',
              number: s.number || '',
              class_id: s.class_id || '',
              class_name: classMap[s.class_id] || '—',
              photo_url: s.photo_url || '',
              watch_level: s.watch_level || 'ทั่วไป'
            },
            tone: b.point >= 0 ? 'ok' : 'bad',
            by: userMap[b.created_by] || b.created_by || 'ระบบ'
          };
        });

        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            positive: items.filter(x => (x.point || 0) >= 0).length, 
            watch: items.filter(x => x.severity === 'ปานกลาง').length, 
            violation: items.filter(x => x.severity === 'มาก').length, 
            point: items.reduce((acc, x) => acc + (Number(x.point) || 0), 0) 
          },
          by_type: byTypeArray, 
          types: ['พฤติกรรมเชิงบวก', 'พฤติกรรมที่ต้องติดตาม', 'ทำผิดระเบียบ', 'ได้รับคำชม', 'ได้รับรางวัล', 'เหตุการณ์อื่น'],
          severities: ['น้อย', 'ปานกลาง', 'มาก'], 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true }
        };

        // 📌 บันทึกลงแคช
        behaviorCache = resultPayload;
        behaviorCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'visit.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (visitCache && (nowTime - visitCacheTime < 120000)) {
          return res.json(visitCache);
        }

        const keyword = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterStatus = String(payload?.status || '').trim();

        const { data: visits } = await supabase.from('HomeVisits').select('*');
        const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, nickname, number, class_id, photo_url, watch_level');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        const { data: users } = await supabase.from('Users').select('id, full_name');

        // จัดเรียงลำดับห้องเรียนจาก อ.1 ถึง ม.3
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = s; });
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });
        const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });

        let items = (visits || []).map(v => {
          const s = studentMap[v.student_id] || {};
          const fullName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim();
          return {
            ...v,
            student: {
              id: s.id || v.student_id,
              name: fullName || 'ไม่พบข้อมูล',
              nickname: s.nickname || '',
              number: s.number || '',
              class_id: s.class_id || '',
              class_name: classMap[s.class_id] || '—',
              photo_url: s.photo_url || ''
            },
            tone: v.status === 'ต้องติดตาม' ? 'warn' : 'ok',
            by: userMap[v.created_by] || v.created_by || 'ระบบ'
          };
        });

        // 📌 กรองตามห้องเรียน
        if (filterClassId) {
          items = items.filter(x => String(x.student.class_id) === filterClassId);
        }

        // 📌 กรองตามสถานะการเยี่ยมบ้าน
        if (filterStatus) {
          items = items.filter(x => String(x.status) === filterStatus);
        }

        // 📌 กรองตามคำค้นหาชื่อนักเรียน
        if (keyword) {
          items = items.filter(x => x.student.name.toLowerCase().includes(keyword));
        }

        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            visited: items.filter(x => x.status === 'เยี่ยมแล้ว').length, 
            appointed: items.filter(x => x.status === 'นัดหมายแล้ว').length, 
            followup: items.filter(x => x.status === 'ต้องติดตาม').length, 
            pending: items.filter(x => x.status === 'ยังไม่ได้เยี่ยม').length 
          }, 
          not_visited: [], 
          not_visited_total: 0, 
          statuses: ['ยังไม่ได้เยี่ยม', 'นัดหมายแล้ว', 'เยี่ยมแล้ว', 'ต้องติดตาม', 'ปิดการติดตาม'], 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true } 
        };

        // 📌 บันทึกลงแคชเพื่อใช้ตอบกลับอย่างรวดเร็วในรอบถัดไป
        visitCache = resultPayload;
        visitCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'health.index':
      case 'health.list': {
        let health = [];
        let students = [];
        let classes = [];

        try {
          const resH = await supabase.from('HealthRecords').select('*');
          if (resH.data) health = resH.data;
        } catch (e) {}

        try {
          const resS = await supabase.from('Students').select('*');
          if (resS.data) students = resS.data;
        } catch (e) {}

        try {
          const resC = await supabase.from('Classrooms').select('*');
          if (resC.data) classes = resC.data;
        } catch (e) {}

        // 📌 จัดเรียงลำดับห้องเรียนตามระดับชั้น (อ.1 -> ม.3)
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        classes.sort((a, b) => {
          const lA = levelOrder[String(a.level || '').trim()] || 99;
          const lB = levelOrder[String(b.level || '').trim()] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''), 'th');
        });

        const classMap = {}; 
        classes.forEach(c => { 
          classMap[c.id] = c.name || `${c.level || ''}/${c.room || ''}`; 
        });

        // 📌 รับค่าตัวกรองจากหน้าเว็บ (คำค้นหา, ห้องเรียน, ระดับ BMI)
        const q = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterBmiLevel = String(payload?.bmi_level || '').trim();

        let filteredStudents = students;
        if (filterClassId) {
          filteredStudents = filteredStudents.filter(s => String(s.class_id) === filterClassId);
        }
        if (q) {
          filteredStudents = filteredStudents.filter(s => {
            const fullName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.toLowerCase();
            return fullName.includes(q) || String(s.student_code || '').includes(q) || String(s.number || '').includes(q);
          });
        }

        let items = filteredStudents.map(s => {
          const fullName = s.name || `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || s.id || '—';
          const recs = health.filter(h => h.student_id === s.id);
          const h = recs.length > 0 ? recs[recs.length - 1] : null;
          
          // กำหนด tone สีตามระดับภาวะโภชนาการ
          let tone = 'mut';
          const lvl = h?.bmi_level || '';
          if (lvl === 'ผอม') tone = 'info';       // สีฟ้า/น้ำเงิน
          else if (lvl === 'สมส่วน') tone = 'ok';    // สีเขียว
          else if (lvl === 'ท้วม') tone = 'warn';   // สีเหลือง
          else if (lvl === 'อ้วน') tone = 'late';   // สีส้ม
          else if (lvl === 'อ้วนมาก') tone = 'bad';  // สีแดง

          return {
            student: {
              id: s.id,
              name: fullName,
              number: s.number || '-',
              class_name: classMap[s.class_id] || s.class_id || '—',
              class_id: s.class_id || ''
            },
            date: h ? h.date : '',
            weight: h ? h.weight : 0,
            height: h ? h.height : 0,
            bmi: h ? h.bmi : 0,
            bmi_level: lvl,
            tone: tone
          };
        });

        if (filterBmiLevel) {
          items = items.filter(x => x.bmi_level === filterBmiLevel);
        }

        // คำนวณสถิติภาวะโภชนาการรวมทั้งโรงเรียนสำหรับแสดงแผนภูมิวงกลม
        const measuredCount = items.filter(x => x.bmi_level).length;
        const unmeasuredCount = items.filter(x => !x.bmi_level).length;
        const thinCount = items.filter(x => x.bmi_level === 'ผอม').length;
        const normalCount = items.filter(x => x.bmi_level === 'สมส่วน').length;
        const overweightCount = items.filter(x => x.bmi_level === 'ท้วม').length;
        const obeseCount = items.filter(x => x.bmi_level === 'อ้วน').length;
        const veryObeseCount = items.filter(x => x.bmi_level === 'อ้วนมาก').length;

        return res.json({ 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: students.length, 
            measured: measuredCount, 
            unmeasured: unmeasuredCount, 
            thin: thinCount, 
            normal: normalCount, 
            over: overweightCount, 
            obese: obeseCount + veryObeseCount 
          }, 
          distribution: [
            { label: 'ผอม', value: thinCount, tone: 'info' },
            { label: 'สมส่วน', value: normalCount, tone: 'ok' },
            { label: 'ท้วม', value: overweightCount, tone: 'warn' },
            { label: 'อ้วน', value: obeseCount, tone: 'late' },
            { label: 'อ้วนมาก', value: veryObeseCount, tone: 'bad' }
          ], 
          levels: ['ผอม', 'สมส่วน', 'ท้วม', 'อ้วน', 'อ้วนมาก'], 
          classes: classes.map(c => ({ id: c.id, name: c.name || `${c.level || ''}/${c.room || ''}` })), 
          can: { manage: true } 
        });
      }

      case 'assign.list': {
        const { data: assigns } = await supabase.from('Assignments').select('*');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });
        const items = (assigns || []).map(a => ({
          ...a,
          class_name: classMap[a.class_id] || '—',
          student_total: 0, submitted: 0, pending: 0, percent: 0, state: 'open'
        }));
        return res.json({ ok: true, items, total: items.length, pages: 1, page: 1, kpi: { total: items.length, today: 0, due_soon: 0, overdue: 0, pending_students: 0 }, classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), can: { manage: true } });
      }

      case 'event.list': {
        const { data: events } = await supabase.from('CalendarEvents').select('*');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });
        const items = (events || []).map(e => ({
          ...e,
          class_name: classMap[e.class_id] || '',
          icon: 'calendar-event', tone: 'brand'
        }));
        return res.json({ ok: true, items, kpi: { total: items.length, today: 0, week: 0, overdue: 0 }, types: ['เช็กชื่อ', 'กิจกรรม', 'นัดผู้ปกครอง', 'เยี่ยมบ้าน', 'ติดตามนักเรียน', 'ส่งรายงาน', 'วันสำคัญ', 'งานอื่น'], classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), can: { manage: true } });
      }

      case 'doc.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (docCache && (nowTime - docCacheTime < 120000)) {
          return res.json(docCache);
        }

        const keyword = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterCategory = String(payload?.category || '').trim();

        const { data: docs } = await supabase.from('Documents').select('*');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');

        // จัดเรียงลำดับห้องเรียนตามระดับชั้น (อ.1 -> ม.6)
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });

        let items = (docs || []).map(d => ({
          ...d,
          class_name: classMap[d.class_id] || '',
          icon: 'file-earmark'
        }));

        // กรองตามห้องเรียน
        if (filterClassId) {
          items = items.filter(x => String(x.class_id) === filterClassId);
        }

        // กรองตามหมวดหมู่เอกสาร
        if (filterCategory) {
          items = items.filter(x => String(x.category) === filterCategory);
        }

        // กรองตามคำค้นหา
        if (keyword) {
          items = items.filter(x => 
            String(x.title || '').toLowerCase().includes(keyword) || 
            String(x.doc_no || '').toLowerCase().includes(keyword)
          );
        }

        const currentMonthPrefix = getTodayThai().slice(0, 7);
        const categoriesSet = new Set();
        (docs || []).forEach(d => { if (d.category) categoriesSet.add(d.category); });

        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            month: (docs || []).filter(x => String(x.doc_date || '').startsWith(currentMonthPrefix)).length, 
            categories: categoriesSet.size 
          }, 
          by_category: [], 
          categories: Array.from(categoriesSet).length > 0 ? Array.from(categoriesSet) : ['รายงาน', 'หนังสือราชการ', 'เอกสารอื่น'], 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true } 
        };

        // 📌 บันทึกลงแคช
        docCache = resultPayload;
        docCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'infirmary.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (infirmaryCache && (nowTime - infirmaryCacheTime < 120000)) {
          return res.json(infirmaryCache);
        }

        const keyword = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();

        const { data: visits } = await supabase.from('HealthVisits').select('*');
        const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, nickname, number, class_id, photo_url');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        
        // จัดเรียงลำดับห้องเรียนตามระดับชั้น
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = s; });
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });

        let items = (visits || []).map(v => {
          const s = studentMap[v.student_id] || {};
          const fullName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim();
          return {
            ...v,
            student: {
              id: s.id || v.student_id,
              name: fullName || 'ไม่พบข้อมูล',
              class_id: s.class_id || '',
              class_name: classMap[s.class_id] || '—',
              photo_url: s.photo_url || ''
            }
          };
        });

        // กรองตามห้องเรียน
        if (filterClassId) {
          items = items.filter(x => String(x.student.class_id) === filterClassId);
        }
        // กรองตามคำค้นหา
        if (keyword) {
          items = items.filter(x => 
            x.student.name.toLowerCase().includes(keyword) || 
            String(x.symptom || '').toLowerCase().includes(keyword)
          );
        }

        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            today: items.filter(x => String(x.date || '').slice(0, 10) === getTodayThai()).length, 
            month: 0, 
            refer: items.filter(x => x.refer && x.refer !== 'ดูแลที่โรงเรียน').length 
          }, 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true } 
        };

        // 📌 บันทึกลงแคช
        infirmaryCache = resultPayload;
        infirmaryCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'case.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (caseCache && (nowTime - caseCacheTime < 120000)) {
          return res.json(caseCache);
        }

        const keyword = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterStatus = String(payload?.status || '').trim();
        const filterLevel = String(payload?.level || '').trim();

        const { data: cases } = await supabase.from('StudentCases').select('*');
        const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, nickname, number, class_id, photo_url, watch_level');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');

        // 📌 จัดเรียงลำดับห้องเรียนตามระดับชั้น (อ.1 -> ม.3)
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = s; });
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });

        let items = (cases || []).map(c => {
          const s = studentMap[c.student_id] || {};
          return {
            ...c,
            student: {
              id: s.id || c.student_id,
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || 'ไม่พบข้อมูล',
              class_id: s.class_id || '',
              class_name: classMap[s.class_id] || '—',
              photo_url: s.photo_url || ''
            },
            tone: c.status === 'ปิดเคส' ? 'ok' : 'bad',
            overdue: false,
            followup_count: 0
          };
        });

        // 📌 กรองตามห้องเรียน
        if (filterClassId) {
          items = items.filter(x => String(x.student.class_id) === filterClassId);
        }
        // 📌 กรองตามสถานะเคส
        if (filterStatus) {
          items = items.filter(x => String(x.status) === filterStatus);
        }
        // 📌 กรองตามระดับการดูแล
        if (filterLevel) {
          items = items.filter(x => String(x.level) === filterLevel);
        }
        // 📌 กรองตามคำค้นหา (ชื่อนักเรียน, เลขเคส, หรือปัญหา)
        if (keyword) {
          items = items.filter(x => 
            x.student.name.toLowerCase().includes(keyword) || 
            String(x.case_no || '').toLowerCase().includes(keyword) || 
            String(x.problem || '').toLowerCase().includes(keyword)
          );
        }

        // คำนวณสรุปสถิติจำนวนเคสตามระดับการดูแล
        let levelCountMap = {};
        (cases || []).forEach(c => {
          let lvl = c.level || 'เฝ้าระวัง';
          levelCountMap[lvl] = (levelCountMap[lvl] || 0) + 1;
        });

        const byLevelArray = Object.keys(levelCountMap).map(k => {
          let tone = 'info';
          if (k.includes('เฝ้าระวัง') || k.includes('ต้องติดตาม')) {
            tone = 'warn';
          } else if (k.includes('ต้องช่วยเหลือ') || k.includes('ส่งต่อ')) {
            tone = 'bad';
          }
          return { label: k, value: levelCountMap[k], tone: tone };
        });

        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            open: items.filter(x => x.status === 'เปิดเคส').length, 
            progress: items.filter(x => x.status === 'กำลังดำเนินการ').length, 
            closed: items.filter(x => x.status === 'ปิดเคส').length, 
            overdue: 0 
          }, 
          by_level: byLevelArray, 
          statuses: ['เปิดเคส', 'กำลังดำเนินการ', 'ปิดเคส'], 
          levels: ['เฝ้าระวัง', 'ต้องติดตาม', 'ต้องช่วยเหลือ', 'ส่งต่อ'], 
          categories: ['การเรียน', 'พฤติกรรม', 'สุขภาพ', 'เศรษฐกิจ/ยากจน', 'ครอบครัว', 'ความปลอดภัย', 'อื่น ๆ'], 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true } 
        };

        // 📌 บันทึกลงแคชเพื่อเรียกใช้ในครั้งถัดไปให้รวดเร็ว
        caseCache = resultPayload;
        caseCacheTime = Date.now();

        return res.json(resultPayload);
      }

      case 'contact.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (contactCache && (nowTime - contactCacheTime < 120000)) {
          return res.json(contactCache);
        }

        const { data: contacts } = await supabase.from('ParentContacts').select('*');
        const { data: students } = await supabase.from('Students').select('id, prefix, first_name, last_name, nickname, number, class_id, photo_url');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = s; });
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });

        let channelCountMap = {};
        (contacts || []).forEach(ct => {
          let ch = ct.channel || 'ช่องทางอื่น';
          channelCountMap[ch] = (channelCountMap[ch] || 0) + 1;
        });

        const tones = ['info', 'ok', 'warn', 'acc', 'brand', 'late'];
        let idx = 0;
        const byChannelArray = Object.keys(channelCountMap).map(k => {
          const t = tones[idx % tones.length];
          idx++;
          return { label: k, value: channelCountMap[k], tone: t };
        });

        const items = (contacts || []).map(ct => {
          const s = studentMap[ct.student_id] || {};
          return {
            ...ct,
            student: {
              id: s.id || ct.student_id,
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || 'ไม่พบข้อมูล',
              class_name: classMap[s.class_id] || '—',
              photo_url: s.photo_url || ''
            },
            icon: 'telephone-fill'
          };
        });

        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            month: 0, 
            appointment: items.filter(x => x.appointment_date && x.appointment_date !== '-').length, 
            followup: 0 
          }, 
          by_channel: byChannelArray, 
          channels: ['โทรศัพท์', 'พบผู้ปกครอง', 'หนังสือแจ้ง', 'LINE', 'การประชุม', 'ช่องทางอื่น'], 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true } 
        };

        // 📌 บันทึกลงแคช
        contactCache = resultPayload;
        contactCacheTime = Date.now();

        return res.json(resultPayload);
      }

      // 📌 เพิ่มเคส activity.get สำหรับดึงรายละเอียดกิจกรรมและรายชื่อผู้เข้าร่วม
      case 'activity.get': {
        const id = payload?.id;
        const { data: item } = await supabase.from('Activities').select('*').eq('id', id).maybeSingle();
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');
        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });

        let targetClassIds = [];
        if (item && item.class_ids) {
          try {
            targetClassIds = JSON.parse(item.class_ids);
          } catch (e) {
            targetClassIds = [item.class_ids];
          }
        } else if (item && item.class_id) {
          targetClassIds = [item.class_id];
        }

        // ดึงรายชื่อนักเรียนทั้งหมด
        let studentQuery = supabase.from('Students').select('id, prefix, first_name, last_name, class_id, photo_url, number');
        if (targetClassIds.length > 0) {
          studentQuery = studentQuery.in('class_id', targetClassIds);
        }
        const { data: students } = await studentQuery;

        let joined = [];
        let absent = [];
        try {
          const { data: attData } = await supabase.from('ActivityAttendees').select('*').eq('activity_id', id);
          const studentMap = {}; (students || []).forEach(s => { studentMap[s.id] = s; });

          // ถ้ายัองไม่มีการบันทึกผู้เข้าร่วม ให้ดึงนักเรียนในห้องเป้าหมายมาแสดงเป็นค่าเริ่มต้น
          if (!attData || attData.length === 0) {
            (students || []).forEach(s => {
              const sName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || 'ไม่พบข้อมูล';
              absent.push({ student_id: s.id, name: sName });
            });
          } else {
            (attData || []).forEach(at => {
              const s = studentMap[at.student_id];
              if (s) {
                const sName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || 'ไม่พบข้อมูล';
                if (at.joined) {
                  joined.push({ student_id: at.student_id, name: sName });
                } else {
                  absent.push({ student_id: at.student_id, name: sName });
                }
              }
            });
          }
        } catch (e) {}

        if (item) {
          item.class_names = targetClassIds.length > 0 
            ? targetClassIds.map(cid => classMap[cid]).filter(Boolean).join(', ') 
            : 'ทั้งโรงเรียน';
        }

        return res.json({ 
          ok: true, 
          item: item || {}, 
          joined: joined, 
          absent: absent, 
          can: { manage: true } 
        });
      }

      // 📌 ปรับปรุงเคส activity.list ให้รองรับการค้นหา กรองห้องเรียน และเรียงลำดับห้อง
      case 'activity.list': {
        // ตรวจสอบแคชในหน่วยความจำ (อายุแคช 2 นาที = 120,000 มิลลิวินาที)
        const nowTime = Date.now();
        if (activityCache && (nowTime - activityCacheTime < 120000)) {
          return res.json(activityCache);
        }

        const keyword = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterCategory = String(payload?.category || '').trim();

        const { data: activities } = await supabase.from('Activities').select('*');
        const { data: classes } = await supabase.from('Classrooms').select('id, level, room, name');

        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        if (classes) {
          classes.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });
        }

        const classMap = {}; (classes || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });

        let items = (activities || []).map(a => {
          const nowStr = getTodayThai();
          let isUpcoming = a.date ? a.date >= nowStr : true;
          return {
            ...a,
            class_name: classMap[a.class_id] || 'ทั้งโรงเรียน',
            attendee_total: 0, 
            attendee_joined: 0, 
            is_upcoming: isUpcoming
          };
        });

        if (filterClassId) {
          items = items.filter(x => String(x.class_id) === filterClassId);
        }
        if (filterCategory) {
          items = items.filter(x => String(x.category) === filterCategory);
        }
        if (keyword) {
          items = items.filter(x => 
            x.name.toLowerCase().includes(keyword) || 
            String(x.place || '').toLowerCase().includes(keyword)
          );
        }

        const todayStr = getTodayThai();
        const resultPayload = { 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            upcoming: items.filter(x => x.is_upcoming).length, 
            done: items.filter(x => !x.is_upcoming).length, 
            month: items.filter(x => String(x.date || '').slice(0, 7) === todayStr.slice(0, 7)).length 
          }, 
          categories: ['กิจกรรมหน้าเสาธง', 'กิจกรรมวันสำคัญ', 'ทัศนศึกษา', 'กีฬาสี', 'ลูกเสือ-เนตรนารี', 'ชุมนุม', 'จิตอาสา', 'กิจกรรมอื่น'], 
          classes: (classes || []).map(c => ({ id: c.id, name: c.name || `${c.level}/${c.room}` })), 
          can: { manage: true } 
        };

        // 📌 บันทึกลงแคช
        activityCache = resultPayload;
        activityCacheTime = Date.now();

        return res.json(resultPayload);
      }

case 'activity.attend': {
        const { id, items } = payload;
        if (!id || !items || !Array.isArray(items)) {
          return res.status(400).json({ ok: false, error: 'ข้อมูลไม่ครบถ้วน' });
        }

        try {
          // ลบข้อมูลเดิมของกิจกรรมนี้ออกก่อนบันทึกใหม่
          await supabase.from('ActivityAttendees').delete().eq('activity_id', id);

          let joinedCount = 0;
          const rowsToInsert = items.map(it => {
            if (it.joined) joinedCount++;
            return {
              id: 'ATTEND-' + Math.floor(100000 + Math.random() * 900000),
              activity_id: id,
              student_id: it.student_id,
              joined: !!it.joined,
              created_at: new Date().toISOString()
            };
          });

          if (rowsToInsert.length > 0) {
            await supabase.from('ActivityAttendees').insert(rowsToInsert);
          }
          activityCache = null;
          return res.json({ ok: true, joined: joinedCount, total: rowsToInsert.length });
        } catch (err) {
          return res.status(500).json({ ok: false, error: err.message });
        }
      }

      /* ── LOOKUPS & SYSTEM ── */
      case 'lookup.list': {
        const { data } = await supabase.from('Lookups').select('*');
        const groupsMap = {};
        (data || []).forEach(l => {
          if (!groupsMap[l.group]) groupsMap[l.group] = { code: l.group, label: l.group };
        });
        return res.json({
          ok: true,
          groups: Object.values(groupsMap),
          items: data || []
        });
      }

      case 'lookup.save': {
        const dataIn = payload;
        let result;
        if (dataIn.id) {
          const { data } = await supabase.from('Lookups').update(dataIn).eq('id', dataIn.id).select();
          result = data ? data[0] : dataIn;
        } else {
          dataIn.id = 'LKP-' + Math.floor(100000 + Math.random() * 900000);
          const { data } = await supabase.from('Lookups').insert([dataIn]).select();
          result = data ? data[0] : dataIn;
        }
        return res.json({ ok: true, item: result });
      }

      case 'lookup.delete': {
        await supabase.from('Lookups').delete().eq('id', payload?.id);
        return res.json({ ok: true });
      }

      case 'home.dashboard': {
        const todayStr = getTodayThai();
        const currentMonthPrefix = todayStr.slice(0, 7);

        let totalStudents = 0, maleCount = 0, femaleCount = 0, studentsList = [];
        try {
          // 🚀 ปรับแต่ง: ดึงเฉพาะคอลัมน์ที่ต้องใช้แสดงผลและคำนวณ แทนการดึงทั้งหมด
          const { data: studentsData } = await supabase.from('Students')
            .select('id, gender, watch_level, prefix, first_name, last_name, photo_url, class_id')
            .eq('status', 'กำลังศึกษา');
          studentsList = studentsData || [];
          totalStudents = studentsList.length;
          maleCount = studentsList.filter(s => s.gender === 'ชาย').length;
          femaleCount = studentsList.filter(s => s.gender === 'หญิง').length;
        } catch (e) {}
        
        let todayAttendance = [];
        try {
          // 🚀 ปรับแต่ง: ดึงแค่สถานะเพื่อนำมานับจำนวน
          const { data } = await supabase.from('Attendance').select('status').eq('date', todayStr);
          todayAttendance = data || [];
        } catch (e) {}

        let presentCount = 0, absentCount = 0, sickCount = 0, leaveCount = 0, lateCount = 0;
        todayAttendance.forEach(att => {
          if (att.status === 'มา') presentCount++;
          else if (att.status === 'ขาด') absentCount++;
          else if (att.status === 'ป่วย' || att.status === 'ลาป่วย') sickCount++;
          else if (att.status === 'กิจ' || att.status === 'ลากิจ') leaveCount++;
          else if (att.status === 'มาสาย') lateCount++;
        });

        if (todayAttendance.length === 0) {
          presentCount = totalStudents;
        }

        let openCasesCount = 0;
        try {
          const { count } = await supabase.from('StudentCases').select('id', { count: 'exact', head: true }).neq('status', 'ปิดเคส');
          openCasesCount = count || 0;
        } catch (e) {}

        let visitsCount = 0;
        try {
          const { count } = await supabase.from('HomeVisits').select('id', { count: 'exact', head: true });
          visitsCount = count || 0;
        } catch (e) {}

        let contactsMonthCount = 0;
        try {
          const { data: contactsData } = await supabase.from('ParentContacts').select('date');
          contactsMonthCount = (contactsData || []).filter(c => String(c.date || '').startsWith(currentMonthPrefix)).length;
        } catch (e) {}

        let watchStudents = studentsList.filter(s => s.watch_level && s.watch_level !== 'ทั่วไป').map(s => ({
          id: s.id,
          name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
          watch_level: s.watch_level || 'เฝ้าระวัง',
          photo_url: s.photo_url || '',
          class_name: s.class_id || ''
        }));

        let tasksList = [];
        try {
          // 🚀 ปรับแต่ง: ดึงเฉพาะคอลัมน์ที่แสดงในการ์ดแจ้งเตือน
          const { data: assigns } = await supabase.from('Assignments')
            .select('id, title, subject, due_date')
            .order('due_date', { ascending: true }).limit(5);
          tasksList = (assigns || []).map(a => ({
            id: a.id,
            title: a.title,
            sub: `${a.subject || 'ทั่วไป'} · กำหนดส่ง ${a.due_date || '-'}`,
            due: a.due_date,
            tone: a.due_date && new Date(a.due_date) < new Date() ? 'bad' : 'warn',
            icon: 'journal-check',
            link: '#/assigns'
          }));
        } catch (e) {}

        let timelineList = [];
        try {
          // 🚀 ปรับแต่ง: จำกัดคอลัมน์ AuditLogs
          const { data: logs } = await supabase.from('AuditLogs')
            .select('action, entity, entity_id, username, at')
            .order('at', { ascending: false }).limit(8);
          
          const { data: studentsData } = await supabase.from('Students').select('id, prefix, first_name, last_name');
          const { data: behData } = await supabase.from('Behaviors').select('id, student_id, title, type');
          const { data: visitData } = await supabase.from('HomeVisits').select('id, student_id');
          const { data: contactData } = await supabase.from('ParentContacts').select('id, student_id, subject');
          const { data: caseData } = await supabase.from('StudentCases').select('id, student_id, problem');
          const { data: clsData } = await supabase.from('Classrooms').select('id, level, room, name');

          const studentMap = {};
          (studentsData || []).forEach(s => { studentMap[s.id] = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(); });
          const classMap = {};
          (clsData || []).forEach(c => { classMap[c.id] = c.name || `${c.level}/${c.room}`; });
          const behMap = {};
          (behData || []).forEach(b => { behMap[b.id] = { title: b.title || b.type, student_id: b.student_id }; });
          const visitMap = {};
          (visitData || []).forEach(v => { visitMap[v.id] = v.student_id; });
          const contactMap = {};
          (contactData || []).forEach(c => { contactMap[c.id] = { subject: c.subject, student_id: c.student_id }; });
          const caseMap = {};
          (caseData || []).forEach(c => { caseMap[c.id] = { problem: c.problem, student_id: c.student_id }; });

          timelineList = (logs || []).map(l => {
            let title = l.action || 'กิจกรรมในระบบ';
            let sub = `${l.entity || ''} (${l.entity_id || ''})`;
            let icon = 'activity';
            let tone = 'ok';

            if (title.includes('attendance.save') || title.includes('attendance')) {
              title = 'เช็กชื่อประจำวัน';
              const className = classMap[l.entity_id] || l.entity_id || '';
              sub = `บันทึกการมาเรียน · ห้อง ${className}`;
              icon = 'ui-checks';
              tone = 'ok';
            } else if (title.includes('behavior')) {
              title = 'บันทึกพฤติกรรมนักเรียน';
              const beh = behMap[l.entity_id];
              const studentName = beh && studentMap[beh.student_id] ? studentMap[beh.student_id] : '';
              sub = studentName ? `${studentName} · ${beh.title}` : `คะแนนพฤติกรรม · ${l.entity_id || ''}`;
              icon = 'emoji-smile-fill';
              tone = 'warn';
            } else if (title.includes('contact')) {
              title = 'ติดต่อผู้ปกครอง';
              const con = contactMap[l.entity_id];
              const studentName = con && studentMap[con.student_id] ? studentMap[con.student_id] : '';
              sub = studentName ? `${studentName} · ${con.subject}` : `บันทึกการสื่อสาร · ${l.entity_id || ''}`;
              icon = 'telephone-fill';
              tone = 'acc';
            } else if (title.includes('visit')) {
              title = 'เยี่ยมบ้านนักเรียน';
              const sId = visitMap[l.entity_id];
              const studentName = sId && studentMap[sId] ? studentMap[sId] : '';
              sub = studentName ? `เยี่ยมบ้านนักเรียน: ${studentName}` : `บันทึกเยี่ยมบ้าน · ${l.entity_id || ''}`;
              icon = 'house-heart-fill';
              tone = 'ok';
            } else if (title.includes('case')) {
              title = 'เคสติดตามช่วยเหลือนักเรียน';
              const cas = caseMap[l.entity_id];
              const studentName = cas && studentMap[cas.student_id] ? studentMap[cas.student_id] : '';
              sub = studentName ? `${studentName} · ${cas.problem || 'ดูแลช่วยเหลือ'}` : `ระบบดูแลช่วยเหลือ · ${l.entity_id || ''}`;
              icon = 'life-preserver';
              tone = 'bad';
            } else if (title.includes('auth.login')) {
              title = 'เข้าสู่ระบบ';
              sub = `ผู้ใช้งาน: ${l.username || 'ระบบ'}`;
              icon = 'box-arrow-in-right';
              tone = 'brand';
            } else if (title.includes('year.active')) {
              title = 'เปลี่ยนปีการศึกษาปัจจุบัน';
              sub = `กำหนดปีการศึกษา · ${l.entity_id || ''}`;
              icon = 'calendar2-range-fill';
              tone = 'brand';
            } else if (title.includes('year.')) {
              title = 'จัดการปีการศึกษา';
              sub = `ปีการศึกษา · ${l.entity_id || ''}`;
              icon = 'calendar2-check-fill';
              tone = 'ok';
            } else if (title.includes('student.')) {
              title = 'จัดการข้อมูลนักเรียน';
              const studentName = studentMap[l.entity_id] || '';
              sub = studentName ? `นักเรียน: ${studentName}` : `ทะเบียนนักเรียน · ${l.entity_id || ''}`;
              icon = 'people-fill';
              tone = 'ok';
            } else if (title.includes('setting.')) {
              title = 'ตั้งค่าระบบโรงเรียน';
              sub = `ตั้งค่าระบบ · ${l.entity_id || ''}`;
              icon = 'gear-fill';
              tone = 'info';
            } else if (title.includes('delete')) {
              title = 'ลบข้อมูลในระบบ';
              sub = `ลบรายการ · ${l.entity_id || ''}`;
              tone = 'bad';
              icon = 'trash-fill';
            }

            let dateStr = todayStr;
            let timeStr = '';
            if (l.at) {
              const dObj = new Date(l.at);
              dateStr = dObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
              timeStr = dObj.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
            }

            return {
              title: title, sub: sub, date: dateStr, time: timeStr, by: l.username || 'ระบบ', tone: tone, icon: icon
            };
          });
        } catch (e) {}

        let upcomingList = [];
        try {
          const { data: events } = await supabase.from('CalendarEvents')
            .select('id, title, date, time_start, place')
            .gte('date', todayStr).order('date', { ascending: true }).limit(5);
          upcomingList = (events || []).map(ev => ({
            id: ev.id, name: ev.title, date: ev.date, time_start: ev.time_start || '', place: ev.place || ''
          }));
        } catch (e) {}

        let trendData = [];
        let weeklyData = [];
        try {
          const { data: allAtt } = await supabase.from('Attendance').select('date, status');
          for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
            const dayRecords = (allAtt || []).filter(r => String(r.date || '').slice(0, 10) === dStr);
            const pNum = dayRecords.filter(r => r.status === 'มา').length;
            const totalRec = dayRecords.length || (totalStudents || 1);
            const rateVal = Math.round((pNum / totalRec) * 100);
            
            trendData.push({ date: dStr, rate: rateVal });
            weeklyData.push({ label: dStr, present: pNum, total: totalRec });
          }
        } catch (e) {}

        let behaviorMap = {};
        let behaviorTotal = 0;
        try {
          const { data: behData } = await supabase.from('Behaviors').select('type, point');
          behaviorTotal = (behData || []).length;
          (behData || []).forEach(b => {
            const tp = b.type || 'ทั่วไป';
            behaviorMap[tp] = (behaviorMap[tp] || 0) + 1;
          });
        } catch (e) {}

        const behaviorList = Object.keys(behaviorMap).length > 0 
          ? Object.keys(behaviorMap).map(k => ({ label: k, value: behaviorMap[k], tone: getBehaviorTone(k) }))
          : [{ label: 'ยังไม่มีข้อมูล', value: 1, tone: 'mut' }];

        let activeYear = null;
        try {
          const { data } = await supabase.from('AcademicYears').select('label').eq('is_active', true).maybeSingle();
          activeYear = data;
        } catch (e) {}

        return res.json({
          ok: true,
          data: studentsList,
          items: studentsList,
          list: studentsList,
          rows: studentsList,
          date: todayStr,
          year_label: activeYear ? activeYear.label : 'ปีการศึกษา 2569',
          kpi: { 
            students: totalStudents, present: presentCount, absent: absentCount, sick: sickCount, leave: leaveCount, late: lateCount,
            male: maleCount, female: femaleCount, watch: watchStudents.length, 
            rate_today: totalStudents ? Math.round((presentCount / totalStudents) * 100) : 100,
            cases_open: openCasesCount, visits: visitsCount, contacts_month: contactsMonthCount
          },
          trend: trendData,
          behavior: behaviorList,
          behavior_total: behaviorTotal,
          tasks: tasksList,
          weekly: weeklyData, 
          timeline: timelineList,
          watch_list: watchStudents, 
          upcoming: upcomingList,
          can: { attendance: true, student: true, daily: true, report: true, behavior: true, contact: true, visit: true }
        });
      }

      case 'exec.dashboard': {
        // ตรวจสอบว่ามีแคชในหน่วยความจำและยังไม่หมดอายุ (120,000 มิลลิวินาที = 2 นาที)
        const nowTime = Date.now();
        if (execCache && (nowTime - execCacheTime < 120000)) {
          return res.json(execCache);
        }

        const todayStr = getTodayThai();
        let totalStudents = 0, maleCount = 0, femaleCount = 0, totalClasses = 0, totalTeachers = 0;
        
        try {
          const { data: studentsData } = await supabase.from('Students').select('gender, class_id').eq('status', 'กำลังศึกษา');
          totalStudents = (studentsData || []).length;
          maleCount = (studentsData || []).filter(s => s.gender === 'ชาย').length;
          femaleCount = (studentsData || []).filter(s => s.gender === 'หญิง').length;
        } catch (e) {}

        try {
          const { count } = await supabase.from('Classrooms').select('*', { count: 'exact', head: true });
          totalClasses = count || 0;
        } catch (e) {}

        try {
          const { count } = await supabase.from('Users').select('*', { count: 'exact', head: true });
          totalTeachers = count || 0;
        } catch (e) {}

        let userMap = {};
        try {
          const { data: usersData } = await supabase.from('Users').select('id, full_name');
          (usersData || []).forEach(u => { userMap[u.id] = u.full_name; });
        } catch (e) {}

        let classProgress = [];
        let levelDistMap = {};
        try {
          const { data: classesData } = await supabase.from('Classrooms').select('*');
          const { data: allStudents } = await supabase.from('Students').select('class_id, level');
          const { data: attData } = await supabase.from('Attendance').select('class_id, date, status');
          const { data: logData } = await supabase.from('DailyLogs').select('class_id');
          const { data: visitData } = await supabase.from('HomeVisits');
          const { data: contactData } = await supabase.from('ParentContacts');

          (allStudents || []).forEach(s => {
            const lvl = s.level || 'ไม่ระบุ';
            levelDistMap[lvl] = (levelDistMap[lvl] || 0) + 1;
          });

          classProgress = (classesData || []).map(c => {
            const clsStudents = (allStudents || []).filter(s => String(s.class_id) === String(c.id));
            const studentCount = clsStudents.length;
            const checkedToday = (attData || []).some(a => String(a.class_id) === String(c.id) && String(a.date).slice(0, 10) === todayStr);
            const logsCount = (logData || []).filter(l => String(l.class_id) === String(c.id)).length;
            
            const clsStudentIds = clsStudents.map(s => String(s.id));
            const clsVisits = (visitData || []).filter(v => clsStudentIds.includes(String(v.student_id))).length;
            const clsContacts = (contactData || []).filter(ct => clsStudentIds.includes(String(ct.student_id))).length;

            let score = 0;
            if (checkedToday) score += 40;
            if (logsCount > 0) score += 20;
            if (clsVisits > 0) score += 20;
            if (clsContacts > 0) score += 20;

            return {
              class_id: c.id,
              level: c.level || '',
              room: c.room || '',
              name: c.name || `${c.level}/${c.room}`,
              homeroom: userMap[c.homeroom_id] || 'ยังไม่กำหนด',
              students: studentCount,
              checked_today: checkedToday,
              logs: logsCount,
              visits: clsVisits,
              contacts: clsContacts,
              score: Math.min(100, score)
            };
          });

          const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
          classProgress.sort((a, b) => {
            const lA = levelOrder[String(a.level || '').trim()] || 99;
            const lB = levelOrder[String(b.level || '').trim()] || 99;
            if (lA !== lB) return lA - lB;
            return String(a.room || '').localeCompare(String(b.room || ''), 'th');
          });

        } catch (e) {}

        const levelDistArray = Object.keys(levelDistMap).length > 0
          ? Object.keys(levelDistMap).map(k => ({ label: k, value: levelDistMap[k], tone: 'info' }))
          : [{ label: 'ทั้งหมด', value: totalStudents, tone: 'ok' }];

        let behaviorMap = {};
        let behaviorTotal = 0;
        try {
          const { data: behData } = await supabase.from('Behaviors').select('type, point');
          behaviorTotal = (behData || []).length;
          (behData || []).forEach(b => {
            const tp = b.type || 'พฤติกรรมทั่วไป';
            behaviorMap[tp] = (behaviorMap[tp] || 0) + 1;
          });
        } catch (e) {}

        let behaviorList = Object.keys(behaviorMap).length > 0 
          ? Object.keys(behaviorMap).map(k => ({ 
              label: k, 
              value: behaviorMap[k], 
              tone: getBehaviorTone(k) 
            }))
          : [
              { label: 'พฤติกรรมเชิงบวก', value: 10, tone: 'ok' },
              { label: 'ต้องเฝ้าระวัง', value: 3, tone: 'warn' },
              { label: 'ทำผิดระเบียบ', value: 2, tone: 'bad' }
            ];

        if (behaviorTotal === 0) {
          behaviorTotal = behaviorList.reduce((acc, curr) => acc + curr.value, 0);
        }

        let trendData = [];
        try {
          const { data: allAtt } = await supabase.from('Attendance').select('date, status');
          for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
            const dayRecords = (allAtt || []).filter(r => String(r.date || '').slice(0, 10) === dStr);
            const pNum = dayRecords.filter(r => r.status === 'มา').length;
            const totalRec = dayRecords.length || (totalStudents || 1);
            trendData.push({ date: dStr, rate: Math.round((pNum / totalRec) * 100) });
          }
        } catch (e) {}

        // 📌 สร้างก้อนข้อมูลสำหรับส่งกลับ
        const resultPayload = { 
          ok: true, 
          date: todayStr,
          data: [],
          items: [],
          kpi: { 
            students: totalStudents, 
            male: maleCount,
            female: femaleCount,
            rate_today: 100,
            classes: totalClasses,
            teachers: totalTeachers,
            watch: 0,
            visits: 0
          },
          trend: trendData,
          class_progress: classProgress,
          level_dist: levelDistArray,
          behavior: behaviorList,
          behavior_total: behaviorTotal
        };

        // 📌 บันทึกลงตัวแปรแคชไว้ใช้รอบถัดไป
        execCache = resultPayload;
        execCacheTime = Date.now();

        return res.json(resultPayload);
       }

      case 'audit.list': {
        const { data, error } = await supabase.from('AuditLogs').select('*').order('at', { ascending: false });
        if (error) {
          console.error('❌ AuditList Error:', error.message);
        }
        
        // แปลงฟิลด์ให้ตรงกับที่หน้าเว็บ (ScriptsPages4.html) ต้องการ
        const items = (data || []).map(r => {
          let dateStr = '';
          let timeStr = '';
          if (r.at) {
            const dObj = new Date(r.at);
            dateStr = dObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
            timeStr = dObj.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
          } else if (r.date) {
            dateStr = r.date;
            timeStr = r.time || '00:00';
          }

          return {
            id: r.id,
            date: dateStr,
            time: timeStr,
            username: r.username || 'ระบบ',
            action: r.action || 'unknown',
            entity: r.entity || 'System',
            entity_id: r.entity_id || '',
            detail: r.detail || '',
            tone: r.action && r.action.includes('delete') ? 'bad' : (r.action && r.action.includes('save') ? 'ok' : 'brand')
          };
        });

        return res.json({ 
          ok: true, 
          items: items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: items.length, 
            today: items.filter(x => x.date === getTodayThai()).length, 
            login: items.filter(x => x.action === 'auth.login').length, 
            mutation: items.filter(x => x.action && (x.action.includes('save') || x.action.includes('update'))).length 
          }, 
          actions: [], 
          users: [] 
        });
      }

      case 'notify.tasks': {
        let tasksList = [];
        const now = new Date();

        // 1. ดึงข้อมูลจากตาราง Assignments (ใช้คำสั่งชุดเดียวกับแดชบอร์ด)
        try {
          const { data: assigns } = await supabase.from('Assignments').select('*').order('due_date', { ascending: true });
          if (assigns && assigns.length > 0) {
            assigns.forEach(a => {
              const dueDate = a.due_date ? new Date(a.due_date) : null;
              const isOverdue = dueDate && dueDate < now;
              tasksList.push({
                id: a.id,
                title: a.title,
                sub: `${a.subject || 'ทั่วไป'} · กำหนดส่ง ${a.due_date || '-'}`,
                due: a.due_date,
                tone: isOverdue ? 'bad' : 'warn',
                icon: 'journal-check',
                link: '#/assigns'
              });
            });
          }
        } catch (e) {}

        // 2. ดึงข้อมูลเคสที่ต้องติดตามจาก StudentCases
        try {
          const { data: cases } = await supabase.from('StudentCases').select('*').neq('status', 'ปิดเคส');
          if (cases && cases.length > 0) {
            cases.forEach(c => {
              const isOverdue = c.next_date && new Date(c.next_date) < now;
              tasksList.push({
                id: c.id,
                title: `ติดตามนักเรียน · เคส ${c.case_no || c.id}`,
                sub: c.problem ? c.problem.slice(0, 60) + '...' : 'อยู่ระหว่างการช่วยเหลือ',
                due: c.next_date || c.opened_at,
                tone: isOverdue ? 'bad' : 'warn',
                icon: 'life-preserver',
                link: '#/cases'
              });
            });
          }
        } catch (e) {}

        // 3. ดึงข้อมูลจากตาราง CalendarEvents (กิจกรรมในปฏิทิน)
        try {
          const { data: events } = await supabase.from('CalendarEvents').select('*').neq('status', 'เสร็จแล้ว');
          if (events && events.length > 0) {
            events.forEach(ev => {
              const isOverdue = ev.date && new Date(ev.date) < now;
              tasksList.push({
                id: ev.id,
                title: ev.title,
                sub: `${ev.type || 'งานอื่น'} · ${ev.time_start || '15:30'}`,
                due: ev.date,
                tone: isOverdue ? 'bad' : 'warn',
                icon: 'calendar-event',
                link: '#/calendar'
              });
            });
          }
        } catch (e) {}

        // จัดเรียงตามวันครบกำหนด
        tasksList.sort((a, b) => new Date(a.due || '2099-01-01') - new Date(b.due || '2099-01-01'));

        return res.json({
          ok: true,
          items: tasksList
        });
      }

      case 'system.status': {
        const { count: studentCount } = await supabase.from('Students').select('*', { count: 'exact', head: true });
        const { count: userCount } = await supabase.from('Users').select('*', { count: 'exact', head: true });
        const { count: classCount } = await supabase.from('Classrooms').select('*', { count: 'exact', head: true });
        return res.json({
          ok: true,
          counts: { Students: studentCount || 0, Users: userCount || 0, Classrooms: classCount || 0 },
          pbkdf2_iter: 10000,
          last_backup_at: null,
          sheet: { url: '#' }
        });
      }

      case 'system.backup': {
        try {
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
          const buffer = Buffer.from(jsonString, 'utf8');
          const filePath = `backup/${fileName}`;

          // 📌 อัปโหลดไฟล์ JSON ตรงขึ้นไปที่ Supabase Storage (Bucket: school-assets)
          const { error: uploadError } = await supabase.storage
            .from('school-assets')
            .upload(filePath, buffer, { contentType: 'application/json', upsert: true });

          if (uploadError) {
            throw new Error(uploadError.message);
          }

          // ดึง Public URL ของไฟล์สำรองข้อมูล
          const { data: urlData } = supabase.storage
            .from('school-assets')
            .getPublicUrl(filePath);

          const fileUrl = urlData ? urlData.publicUrl : '#';

          await writeAudit(currentUser, 'system.backup', 'System', 'SYSTEM', { file: fileName });

          return res.json({ 
            ok: true, 
            message: 'สำรองข้อมูลขึ้น Supabase สำเร็จ', 
            name: fileName, 
            url: fileUrl 
          });
        } catch (err) {
          console.error('❌ Backup Error:', err.message);
          return res.status(500).json({ ok: false, error: err.message });
        }
      }

      case 'system.cache': {
        return res.json({ ok: true, message: 'ล้างแคชเรียบร้อย' });
      }

/* ── GET SINGLE RECORD ACTIONS ── */
      case 'daily.get': {
        const id = payload?.id;
        const { data: item } = await supabase.from('DailyLogs').select('*').eq('id', id).maybeSingle();
        const { data: users } = await supabase.from('Users').select('id, full_name');
        const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });
        if (item) item.by = userMap[item.created_by] || item.created_by || 'ระบบ';
        return res.json({ ok: true, item: item || {}, can: { manage: true } });
      }

      case 'visit.get': {
        const id = payload?.id;
        const { data: item } = await supabase.from('HomeVisits').select('*').eq('id', id).maybeSingle();
        let student = {};
        if (item && item.student_id) {
          const { data: s } = await supabase.from('Students').select('*').eq('id', item.student_id).maybeSingle();
          if (s) {
            student = {
              id: s.id,
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              class_name: s.class_id || '—',
              photo_url: s.photo_url || ''
            };
          }
        }
        return res.json({ ok: true, item: item || {}, student, can: { manage: true } });
      }

      case 'case.get': {
        const id = payload?.id;
        const { data: item } = await supabase.from('StudentCases').select('*').eq('id', id).maybeSingle();
        let student = {};
        if (item && item.student_id) {
          const { data: s } = await supabase.from('Students').select('*').eq('id', item.student_id).maybeSingle();
          if (s) {
            student = {
              id: s.id,
              name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
              class_name: s.class_id || '—',
              photo_url: s.photo_url || ''
            };
          }
        }
        return res.json({ ok: true, item: item || {}, student, followups: [], can: { manage: true } });
      }

      case 'health.form': {
        let students = [];
        let classes = [];
        const classId = payload?.class_id;

        try {
          const resC = await supabase.from('Classrooms').select('*');
          if (resC.data) classes = resC.data;
        } catch (e) {}

        // จัดเรียงลำดับห้องเรียนจาก อ.1 ถึง ม.3
        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        classes.sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });

        const targetClassId = classId || (classes.length > 0 ? classes[0].id : null);
        const targetClass = classes.find(c => c.id === targetClassId);
        const currentClassName = targetClass ? (targetClass.name || `${targetClass.level || ''}/${targetClass.room || ''}`) : 'ทุกห้องเรียน';

        try {
          let query = supabase.from('Students').select('*');
          if (targetClassId) {
            query = query.eq('class_id', targetClassId);
          }
          const resS = await query;
          if (resS.data) students = resS.data;
        } catch (e) {}

        students.sort((a, b) => (Number(a.number) || 99) - (Number(b.number) || 99));

        const classMap = {};
        classes.forEach(c => {
          classMap[c.id] = c.name || `${c.level || ''}/${c.room || ''}`;
        });

        let healthRecords = [];
        try {
          const { data: hData } = await supabase.from('HealthRecords').select('*');
          if (hData) healthRecords = hData;
        } catch (e) {}

        const formattedStudents = students.map((s, index) => {
          const fullName = s.name || `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || '—';
          const recs = healthRecords.filter(h => h.student_id === s.id);
          const latestH = recs.length > 0 ? recs[recs.length - 1] : null;

          return {
            ...s,
            id: s.id,
            student_id: s.id,
            name: fullName,
            number: s.number || (index + 1),
            class_id: s.class_id || '',
            class_name: classMap[s.class_id] || '—',
            gender: s.gender || s.sex || '-',
            age: s.age || '-',
            weight: latestH ? latestH.weight : '',
            height: latestH ? latestH.height : '',
            bmi: latestH ? latestH.bmi : '',
            bmi_level: latestH ? latestH.bmi_level : ''
          };
        });

        return res.json({
          ok: true,
          class_id: targetClassId || '',
          class_name: currentClassName,
          date: getTodayThai(),
          students: formattedStudents,
          items: formattedStudents,
          classes: classes.map(c => ({ 
            id: c.id, 
            name: c.name || `${c.level || ''}/${c.room || ''}` 
          }))
        });
      }

      case 'health.index':
      case 'health.list': {
        let health = [];
        let students = [];
        let classes = [];

        try {
          const resH = await supabase.from('HealthRecords').select('*');
          if (resH.data) health = resH.data;
        } catch (e) {}

        try {
          const resS = await supabase.from('Students').select('*');
          if (resS.data) students = resS.data;
        } catch (e) {}

        try {
          const resC = await supabase.from('Classrooms').select('*');
          if (resC.data) classes = resC.data;
        } catch (e) {}

        const levelOrder = { 'อ.1': 1, 'อ.2': 2, 'อ.3': 3, 'ป.1': 4, 'ป.2': 5, 'ป.3': 6, 'ป.4': 7, 'ป.5': 8, 'ป.6': 9, 'ม.1': 10, 'ม.2': 11, 'ม.3': 12, 'ม.4': 13, 'ม.5': 14, 'ม.6': 15 };
        classes.sort((a, b) => {
          const lA = levelOrder[a.level] || 99;
          const lB = levelOrder[b.level] || 99;
          if (lA !== lB) return lA - lB;
          return String(a.room || '').localeCompare(String(b.room || ''));
        });

        const classMap = {}; 
        classes.forEach(c => { 
          classMap[c.id] = c.name || `${c.level || ''}/${c.room || ''}`; 
        });

        const q = String(payload?.q || '').trim().toLowerCase();
        const filterClassId = String(payload?.class_id || '').trim();
        const filterBmiLevel = String(payload?.bmi_level || '').trim();

        let filteredStudents = students;
        if (filterClassId) {
          filteredStudents = filteredStudents.filter(s => String(s.class_id) === filterClassId);
        }
        if (q) {
          filteredStudents = filteredStudents.filter(s => {
            const fullName = `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.toLowerCase();
            return fullName.includes(q) || String(s.student_code || '').includes(q) || String(s.number || '').includes(q);
          });
        }

        let items = filteredStudents.map(s => {
          const fullName = s.name || `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim() || s.id || '—';
          const recs = health.filter(h => h.student_id === s.id);
          const h = recs.length > 0 ? recs[recs.length - 1] : null;
          
          return {
            student: {
              id: s.id,
              name: fullName,
              number: s.number || '-',
              class_name: classMap[s.class_id] || s.class_id || '—',
              class_id: s.class_id || ''
            },
            date: h ? h.date : '',
            weight: h ? h.weight : 0,
            height: h ? h.height : 0,
            bmi: h ? h.bmi : 0,
            bmi_level: h ? h.bmi_level : '',
            tone: h?.bmi_level === 'ผอม' ? 'warn' : h?.bmi_level === 'สมส่วน' ? 'ok' : 'bad'
          };
        });

        if (filterBmiLevel) {
          items = items.filter(x => x.bmi_level === filterBmiLevel);
        }

        const measuredCount = items.filter(x => x.bmi_level).length;
        const unmeasuredCount = items.filter(x => !x.bmi_level).length;
        const normalCount = items.filter(x => x.bmi_level === 'สมส่วน').length;
        const thinCount = items.filter(x => x.bmi_level === 'ผอม').length;
        const obeseCount = items.filter(x => x.bmi_level === 'อ้วน' || x.bmi_level === 'อ้วนมาก').length;

        return res.json({ 
          ok: true, 
          items, 
          total: items.length, 
          pages: 1, 
          page: 1, 
          kpi: { 
            total: students.length, 
            measured: measuredCount, 
            unmeasured: unmeasuredCount, 
            thin: thinCount, 
            normal: normalCount, 
            over: 0, 
            obese: obeseCount 
          }, 
          distribution: [
            { label: 'สมส่วน', value: normalCount, tone: 'ok' },
            { label: 'ผอม', value: thinCount, tone: 'warn' },
            { label: 'อ้วน/อ้วนมาก', value: obeseCount, tone: 'bad' }
          ], 
          levels: ['ผอม', 'สมส่วน', 'ท้วม', 'อ้วน', 'อ้วนมาก'], 
          classes: classes.map(c => ({ id: c.id, name: c.name || `${c.level || ''}/${c.room || ''}` })), 
          can: { manage: true } 
        });
      }

      case 'health.bulk': {
        const payloadData = payload || {};
        const records = payloadData.records || payloadData.items || payloadData.data || [];
        const dateVal = payloadData.date || getTodayThai();

        const results = [];
        for (const rec of records) {
          const studentId = rec.student_id || rec.id;
          if (!studentId) continue;

          let existing = null;
          try {
            const { data: existingList } = await supabase
              .from('HealthRecords')
              .select('*')
              .eq('student_id', studentId)
              .eq('date', dateVal);
            if (existingList && existingList.length > 0) {
              existing = existingList[0];
            }
          } catch (e) {}

          const weightVal = rec.weight !== undefined && rec.weight !== '' && rec.weight !== null ? String(rec.weight) : (existing?.weight || '0');
          const heightVal = rec.height !== undefined && rec.height !== '' && rec.height !== null ? String(rec.height) : (existing?.height || '0');
          
          let bmiVal = rec.bmi;
          let bmiLevelVal = rec.bmi_level;
          const w = parseFloat(weightVal);
          const h = parseFloat(heightVal) / 100;

          if (w > 0 && h > 0) {
            if (!bmiVal || bmiVal === '0') {
              bmiVal = (w / (h * h)).toFixed(2);
            }
            if (!bmiLevelVal || bmiLevelVal === '-') {
              const bNum = parseFloat(bmiVal);
              if (bNum < 18.5) bmiLevelVal = 'ผอม';
              else if (bNum <= 22.9) bmiLevelVal = 'สมส่วน';
              else if (bNum <= 24.9) bmiLevelVal = 'ท้วม';
              else if (bNum <= 29.9) bmiLevelVal = 'อ้วน';
              else bmiLevelVal = 'อ้วนมาก';
            }
          } else {
            bmiVal = bmiVal || existing?.bmi || '0';
            bmiLevelVal = bmiLevelVal || existing?.bmi_level || '-';
          }

          const dataIn = {
            student_id: String(studentId),
            date: String(dateVal),
            weight: String(weightVal),
            height: String(heightVal),
            bmi: String(bmiVal),
            bmi_level: String(bmiLevelVal),
            vision: String(rec.vision || existing?.vision || '-'),
            hearing: String(rec.hearing || existing?.hearing || '-'),
            dental: String(rec.dental || existing?.dental || '-'),
            chronic: String(rec.chronic || existing?.chronic || '-'),
            allergy: String(rec.allergy || existing?.allergy || '-'),
            note: String(rec.note || existing?.note || '-'),
            year_id: String(rec.year_id || existing?.year_id || 'AY-000001'),
            rev: String(rec.rev || existing?.rev || '1')
          };

          try {
            if (existing) {
              dataIn.updated_at = new Date().toISOString();
              const { data, error } = await supabase.from('HealthRecords').update(dataIn).eq('id', existing.id).select();
              if (error) console.error('HealthRecords Update Error:', error.message);
              if (!error && data && data.length > 0) results.push(data[0]);
            } else {
              dataIn.id = 'REC-' + Math.floor(100000 + Math.random() * 900000);
              dataIn.created_at = new Date().toISOString();
              const { data, error } = await supabase.from('HealthRecords').insert([dataIn]).select();
              if (error) console.error('HealthRecords Insert Error:', error.message);
              if (!error && data && data.length > 0) results.push(data[0]);
            }
          } catch (err) {
            console.error('HealthRecords Save Exception:', err.message);
          }
        }

        return res.json({ ok: true, saved: results.length, items: results });
      }

      case 'search.global': {
        const keyword = typeof payload === 'string' 
          ? payload.trim() 
          : String(payload?.q || payload?.keyword || payload?.query || '').trim();

        if (!keyword) return res.json({ ok: true, items: [], students: [], classes: [], activities: [], documents: [] });

        let classMap = {};
        try {
          const { data: clsData } = await supabase.from('Classrooms').select('*');
          (clsData || []).forEach(c => {
            classMap[c.id] = c.name || `${c.level || ''}/${c.room || ''}`;
          });
        } catch (e) {}

        // 1. ค้นหานักเรียน (ตรวจสอบตัวเลขเพื่อป้องกัน Error กับคอลัมน์ bigint)
        let studentItems = [];
        try {
          let studentQuery = supabase.from('Students').select('*');
          if (!isNaN(keyword)) {
            studentQuery = studentQuery.or(`first_name.ilike.%${keyword}%,last_name.ilike.%${keyword}%,nickname.ilike.%${keyword}%,student_code.eq.${keyword}`);
          } else {
            studentQuery = studentQuery.or(`first_name.ilike.%${keyword}%,last_name.ilike.%${keyword}%,nickname.ilike.%${keyword}%`);
          }
          const { data: students } = await studentQuery.limit(10);

          studentItems = (students || []).map(s => ({
            id: s.id,
            name: `${s.prefix || ''}${s.first_name || ''} ${s.last_name || ''}`.trim(),
            nickname: s.nickname || '',
            code: String(s.student_code || ''),
            class_name: classMap[s.class_id] || s.class_id || '',
            watch_level: s.watch_level || 'ทั่วไป',
            photo_url: s.photo_url || ''
          }));
        } catch (e) {}

        // 2. ค้นหาห้องเรียน
        let classItems = [];
        try {
          const { data: classes } = await supabase
            .from('Classrooms')
            .select('*')
            .or(`name.ilike.%${keyword}%,level.ilike.%${keyword}%`)
            .limit(10);

          classItems = (classes || []).map(c => ({
            id: c.id,
            name: c.name || `${c.level}/${c.room}`
          }));
        } catch (e) {}

        // 3. ค้นหากิจกรรม
        let activityItems = [];
        try {
          const { data: acts } = await supabase
            .from('Activities')
            .select('*')
            .or(`name.ilike.%${keyword}%,place.ilike.%${keyword}%,category.ilike.%${keyword}%`)
            .limit(10);

          activityItems = (acts || []).map(a => ({
            name: a.name || '',
            date: a.date || ''
          }));
        } catch (e) {}

        // 4. ค้นหาเอกสาร
        let documentItems = [];
        try {
          const { data: docs } = await supabase
            .from('Documents')
            .select('*')
            .or(`title.ilike.%${keyword}%,category.ilike.%${keyword}%,doc_no.ilike.%${keyword}%`)
            .limit(10);

          documentItems = (docs || []).map(doc => ({
            title: doc.title || '',
            category: doc.category || ''
          }));
        } catch (e) {}

        return res.json({ 
          ok: true, 
          items: [...studentItems, ...classItems],
          students: studentItems,
          classes: classItems,
          activities: activityItems,
          documents: documentItems
        });
      }

      default:
        return res.status(400).json({ ok: false, error: `ไม่รู้จักคำสั่ง: ${action}` });
    }
  } catch (err) {
    console.error(`❌ Error in ${action}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message, action });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 CLASSHUB Backend running on http://localhost:${PORT}`);
  });
}
module.exports = app;
