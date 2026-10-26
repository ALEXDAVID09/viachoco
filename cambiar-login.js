const fs = require('fs');
const cargar = f => { const t = fs.readFileSync(f, 'utf8'); return { f, crlf: t.includes('\r\n'), s: t.replace(/\r\n/g, '\n') }; };
const srv = cargar('server.js'), web = cargar('public/index.html');

if (web.s.includes('au-nomw')) { console.log('Ya estaba aplicado. No se hizo nada.'); process.exit(0); }

function rep(o, n, de, por) {
  const i = o.s.indexOf(de);
  if (i < 0 || o.s.indexOf(de, i + 1) >= 0) { console.error('✖ No se pudo aplicar "' + n + '". No se modificó ningún archivo.'); process.exit(1); }
  o.s = o.s.replace(de, () => por);
}

if (!srv.s.includes('nuevo:')) rep(srv, 'server.js',
  "res.json({ ok: true, devCode: DEV ? code : undefined });",
  "const ex = await pool.query('SELECT 1 FROM usuarios WHERE celular=$1', [cel]);\n  res.json({ ok: true, nuevo: ex.rowCount === 0, devCode: DEV ? code : undefined });");

rep(web, 'a (quitar nombre del paso 1)',
  '<label for="au-nom">Nombre (solo la primera vez)</label><input type="text" id="au-nom" autocomplete="name">', '');

rep(web, 'b (nombre en el paso 2)',
  '<p class="hint" id="au2-info"></p>',
  '<p class="hint" id="au2-info"></p>\n   <div id="au-nomw" hidden><label for="au-nom">Su nombre (es su primera vez)</label><input type="text" id="au-nom" autocomplete="name"></div>');

rep(web, 'c (mostrar nombre si es nuevo)',
  "$('#au-1').hidden=true;$('#au-2').hidden=false;$('#au-cod').focus()",
  "$('#au-nomw').hidden=!d.nuevo;$('#au-1').hidden=true;$('#au-2').hidden=false;$(d.nuevo?'#au-nom':'#au-cod').focus()");

rep(web, 'd (exigir nombre solo a nuevos)',
  "const E=$('#au2-err');E.textContent='';",
  "const E=$('#au2-err');E.textContent='';if(!$('#au-nomw').hidden&&$('#au-nom').value.trim().length<3)return E.textContent='Escriba su nombre para crear la cuenta.';");

for (const o of [srv, web]) fs.writeFileSync(o.f, o.crlf ? o.s.replace(/\n/g, '\r\n') : o.s, 'utf8');
console.log('✔ Listo: server.js y public/index.html actualizados.');