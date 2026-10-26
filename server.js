require('dotenv').config();
const express = require('express'), { Pool } = require('pg'), jwt = require('jsonwebtoken');
const crypto = require('crypto'), path = require('path');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || !process.env.DATABASE_URL) { console.error('Falta DATABASE_URL o JWT_SECRET en .env'); process.exit(1); }
const DEV = process.env.NODE_ENV !== 'production';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json({ limit: '1mb' }));

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const wrap = f => (req, res, next) => f(req, res, next).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function uidFrom(req) {
  try { return jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET).uid; } catch (e) { return null; }
}
const optAuth = (req, res, next) => { req.uid = uidFrom(req); next(); };
const auth = (req, res, next) => { req.uid = uidFrom(req); req.uid ? next() : bad(res, 'Debe iniciar sesión', 401); };

/* ---------- Login por código SMS ---------- */
const limpiarCel = v => String(v || '').replace(/[\s-]/g, '');

app.post('/api/auth/solicitar', wrap(async (req, res) => {
  const cel = limpiarCel(req.body.celular);
  if (!/^\+?[0-9]{10,15}$/.test(cel)) return bad(res, 'Celular no válido');
  const n = await pool.query("SELECT count(*)::int n FROM codigos_verificacion WHERE celular=$1 AND creado_en>now()-interval '1 hour'", [cel]);
  if (n.rows[0].n >= 5) return bad(res, 'Demasiados intentos. Espere una hora.', 429);
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query('INSERT INTO codigos_verificacion(celular,codigo_hash) VALUES($1,$2)', [cel, sha(code)]);
  console.log(`[SMS simulado] ${cel}: ${code}`);          // Aquí se conectaría un proveedor real de SMS
  res.json({ ok: true, devCode: DEV ? code : undefined });
}));

app.post('/api/auth/verificar', wrap(async (req, res) => {
  const cel = limpiarCel(req.body.celular), codigo = String(req.body.codigo || '').trim();
  const nombre = String(req.body.nombre || '').trim().slice(0, 80) || 'Usuario';
  const c = (await pool.query('SELECT id,codigo_hash,intentos FROM codigos_verificacion WHERE celular=$1 AND NOT usado AND expira_en>now() ORDER BY creado_en DESC LIMIT 1', [cel])).rows[0];
  if (!c) return bad(res, 'El código venció. Pida uno nuevo.');
  if (c.intentos >= 5) return bad(res, 'Demasiados intentos con este código.', 429);
  if (sha(codigo) !== c.codigo_hash) {
    await pool.query('UPDATE codigos_verificacion SET intentos=intentos+1 WHERE id=$1', [c.id]);
    return bad(res, 'Código incorrecto');
  }
  await pool.query('UPDATE codigos_verificacion SET usado=true WHERE id=$1', [c.id]);
  const u = (await pool.query(
    `INSERT INTO usuarios(celular,celular_verificado,nombre) VALUES($1,true,$2)
     ON CONFLICT(celular) DO UPDATE SET celular_verificado=true
     RETURNING id,nombre,rol,reputacion,activo`, [cel, nombre])).rows[0];
  if (!u.activo) return bad(res, 'Cuenta desactivada', 403);
  res.json({ token: jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }), usuario: { nombre: u.nombre, rol: u.rol, reputacion: u.reputacion } });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const u = (await pool.query('SELECT id,nombre,rol,reputacion FROM usuarios WHERE id=$1 AND activo', [req.uid])).rows[0];
  u ? res.json(u) : bad(res, 'Sesión no válida', 401);
}));

/* ---------- Reportes ---------- */
app.get('/api/reportes', optAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id,r.tramo_id,r.tipo,r.gravedad,r.descripcion,r.lat,r.lng,r.foto_url,r.canal,r.estado,r.creado_en,r.verificado_en,
            1+count(c.*) FILTER (WHERE c.voto='confirma') AS confirmaciones,
            count(c.*) FILTER (WHERE c.voto='descarta') AS descartes,
            COALESCE(r.usuario_id=$1::uuid,false) AS mio
       FROM reportes r LEFT JOIN confirmaciones c ON c.reporte_id=r.id
      WHERE r.estado<>'resuelto' OR r.creado_en>now()-interval '7 days'
      GROUP BY r.id ORDER BY r.creado_en DESC LIMIT 300`, [req.uid]);
  res.json(rows);
}));

const TIPOS = ['derrumbe', 'hundimiento', 'inundacion', 'cierre', 'restriccion'], CANALES = ['app_web', 'sms', 'whatsapp'];

app.post('/api/reportes', auth, wrap(async (req, res) => {
  const b = req.body, lat = Number(b.lat), lng = Number(b.lng);
  const tipo = b.tipo, grav = tipo === 'cierre' ? 3 : Number(b.gravedad);
  if (!TIPOS.includes(tipo)) return bad(res, 'Tipo de incidente no válido');
  if (![1, 2, 3].includes(grav)) return bad(res, 'Gravedad no válida');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad(res, 'Ubicación no válida');
  const t = (await pool.query('SELECT puntos FROM tramos WHERE id=$1', [b.tramo])).rows[0];
  if (!t) return bad(res, 'Tramo no válido');
  const near = t.puntos.some(p => Math.hypot(p[0] - lat, p[1] - lng) < 0.5);   // cerca del trazado
  if (!near) return bad(res, 'La ubicación está lejos de ese tramo');
  const desc = String(b.descripcion || '').slice(0, 500);
  const foto = typeof b.foto === 'string' && b.foto.startsWith('data:image/') && b.foto.length < 400000 ? b.foto : null;
  const canal = CANALES.includes(b.canal) ? b.canal : 'app_web';
  const n = await pool.query("SELECT count(*)::int n FROM reportes WHERE usuario_id=$1 AND creado_en>now()-interval '1 hour'", [req.uid]);
  if (n.rows[0].n >= 10) return bad(res, 'Límite de 10 reportes por hora', 429);
  const r = await pool.query(
    `INSERT INTO reportes(tramo_id,usuario_id,tipo,gravedad,descripcion,lat,lng,gps_real,foto_url,canal)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,estado`,
    [b.tramo, req.uid, tipo, grav, desc, lat, lng, !!b.gps_real, foto, canal]);
  res.status(201).json(r.rows[0]);
}));

app.post('/api/reportes/:id/votos', auth, wrap(async (req, res) => {
  const voto = req.body.voto;
  if (!['confirma', 'descarta'].includes(voto)) return bad(res, 'Voto no válido');
  await pool.query('INSERT INTO confirmaciones(reporte_id,usuario_id,voto) VALUES($1,$2,$3)', [req.params.id, req.uid, voto]);
  res.json({ ok: true });
}));

app.post('/api/reportes/:id/resolver', auth, wrap(async (req, res) => {
  await pool.query('SELECT resolver_reporte($1,$2)', [req.params.id, req.uid]);
  res.json({ ok: true });
}));

/* ---------- Solicitar rol de líder o autoridad (lo aprueba un admin/autoridad) ---------- */
app.post('/api/solicitudes-rol', auth, wrap(async (req, res) => {
  const { rol, entidad_id, soporte_url } = req.body;
  if (!['lider', 'autoridad'].includes(rol)) return bad(res, 'Rol no válido');
  await pool.query('INSERT INTO solicitudes_rol(usuario_id,rol_solicitado,entidad_id,soporte_url) VALUES($1,$2,$3,$4)',
    [req.uid, rol, entidad_id || null, soporte_url || null]);
  res.status(201).json({ ok: true });
}));

/* ---------- Sitio y errores ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  if (err.code === 'P0001') return bad(res, err.message.replace(/^.*?: /, ''));   // reglas de la base de datos
  if (err.code === '23505') return bad(res, 'Ya votó este reporte', 409);
  if (err.code === '23503') return bad(res, 'Dato relacionado no encontrado');
  if (err.code === '22P02') return bad(res, 'Identificador no válido');
  console.error(err); bad(res, 'Error del servidor', 500);
});

app.listen(process.env.PORT || 3000, () => console.log('ViaChocó Alerta en http://localhost:' + (process.env.PORT || 3000)));