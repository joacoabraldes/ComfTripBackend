/**
 * test-db.js
 * Este script intenta cargar db.js desde rutas comunes ('./db' o './backend/db')
 * y realiza una consulta simple para comprobar la conexión.
 */

(async () => {
  // intentamos require en varias rutas posibles
  const tryPaths = ['./db', './backend/db', './server/db', './src/db'];
  let pool = null;
  for (const p of tryPaths) {
    try {
      pool = require(p);
      console.log('Usando conexión desde:', p);
      break;
    } catch (err) {
      // no hacer nada y probar siguiente ruta
    }
  }

  if (!pool) {
    console.error('No se encontró db.js en las rutas esperadas:', tryPaths.join(', '));
    console.error('Asegurate de tener db.js en la raíz o en ./backend/db y corregí la ruta.');
    process.exit(1);
  }

  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS result');
    console.log('Conexión OK, resultado:', rows[0].result);
    process.exit(0);
  } catch (err) {
    console.error('Error conectando a la DB:', err.code || err.message);
    console.error('Detalles:', err);
    process.exit(1);
  }
})();
